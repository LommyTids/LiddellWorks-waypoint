import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalD1 } from '../../scripts/backend-v1/local-d1.mjs';
import { buildImport } from '../../scripts/backend-v1/plan-import.mjs';
import { initializeRehearsal,importPlan,verifyData,verifyPermissions,completeRehearsal,batches } from '../../scripts/backend-v1/import-rehearsal.mjs';
import { Cloudflare,RemoteD1 } from '../../scripts/backend-v1/cloudflare.mjs';
import { exportSnapshot,verifySourceStable } from '../../scripts/backend-v1/source.mjs';

function fixture(count=3){
 const users={users:[{id:'owner',username:'Owner',passwordHash:'private-hash',passwordSalt:'private-salt',sessionVersion:4},{id:'guest',username:'Guest'},{id:'viewer',username:'Viewer'},{id:'admin',username:'Admin'},{id:'uber',username:'Uber',isUberUser:true}]};
 const trip={name:'Private trip',homeCurrency:'GBP',notes:'Private notes',currencyRates:{USD:0.74},_revision:17,geocodeCache:{privateAddress:{lat:40,lng:-74}},extension:{retained:true},companions:[{companionId:1,name:'Guest',accountId:'guest'},{companionId:2,name:'Viewer',accountId:'viewer'}],destinations:[{destinationId:1,name:'Area',companions:[1,2]}],contacts:[{contactId:1,name:'Shared contact'},{contactId:2,name:'Hidden contact'}],activities:Array.from({length:count},(_,i)=>({activityId:i+1,title:'Activity '+i,bookingRef:'PRIVATE_BOOKING',futureField:{keep:true},companions:i===0?[1,2]:[],...(i===0?{contactId:1,destinationId:1}:{})})),transport:[],accommodation:[],expenses:[{expenseId:1,description:'Private expense',amount:'23.45'}]};
 const index={trips:[{tripId:'trip1',ownerId:'owner',grants:[{accountId:'guest',role:'user',companionId:1},{accountId:'viewer',role:'viewer',companionId:2},{accountId:'admin',role:'admin'}]}]};
 return {format:'waypoint-kv-export-v1',entries:{users:JSON.stringify(users),users_initialized:'1',trip_index:JSON.stringify(index),'trip:trip1':JSON.stringify(trip),'cache:example':'cached provider value'}};
}
async function db(t){const d=new LocalD1();t.after(()=>d.close());await initializeRehearsal(d);return d;}

test('complete rehearsal preserves every payload and grant and checks account visibility',async t=>{
 const d=await db(t),source=fixture(),before=JSON.stringify(source),plan=buildImport(source);
 await importPlan(d,plan);const counts=await verifyData(d,source);assert.equal(counts.records,9);assert.equal(counts.grants,3);
 assert.deepEqual(await verifyPermissions(d,source),{accountsChecked:5,outsiderDenied:true});
 assert.equal(await d.prepare('SELECT * FROM import_manifest').first(),null);
 await completeRehearsal(d,plan);assert.equal((await d.prepare('SELECT state FROM rehearsal_control').first()).state,'verified');
 assert.equal(JSON.stringify(source),before);assert(!JSON.stringify(plan).includes('private-hash'));
 await importPlan(d,plan);await verifyData(d,source);await completeRehearsal(d,plan);
 assert.equal((await d.prepare('SELECT count(*) AS n FROM import_manifest').first()).n,1);
});

test('resume after partially applied batch does not duplicate records or events',async t=>{
 const d=await db(t),source=fixture(45),plan=buildImport(source);assert(batches(plan).length>2);
 const batch=d.batch.bind(d);let failed=false;
 d.batch=async statements=>{
   if(!failed&&statements[0].sql.startsWith('INSERT OR IGNORE INTO trips')){failed=true;statements.slice(0,3).forEach(s=>s.execute());throw Error('Lost transport response with private SQL');}
   return batch(statements);
 };
 await assert.rejects(importPlan(d,plan),e=>e.code==='import_interrupted');
 assert.equal((await d.prepare('SELECT next_batch FROM rehearsal_control').first()).next_batch,0);
 await importPlan(d,plan);await verifyData(d,source);
});

test('resume after committed batch response is lost uses its durable checkpoint',async t=>{
 const d=await db(t),source=fixture(45),plan=buildImport(source);const batch=d.batch.bind(d);let failed=false;
 d.batch=async statements=>{const out=await batch(statements);if(!failed&&statements[0].sql.startsWith('INSERT OR IGNORE INTO trips')){failed=true;throw Error('response lost');}return out;};
 await assert.rejects(importPlan(d,plan),e=>e.code==='import_interrupted');assert.equal((await d.prepare('SELECT next_batch FROM rehearsal_control').first()).next_batch,1);
 await importPlan(d,plan);await verifyData(d,source);
});

test('existing destinations and mismatched resumed source are refused',async t=>{
 const occupied=new LocalD1();t.after(()=>occupied.close());occupied.sqlite.exec('CREATE TABLE existing_data(value TEXT)');
 await assert.rejects(initializeRehearsal(occupied),e=>e.code==='destination_not_empty');
 const d=await db(t),source=fixture();await importPlan(d,buildImport(source));const other=fixture();other.entries['cache:example']='changed';
 await assert.rejects(importPlan(d,buildImport(other)),e=>e.code==='resume_source_mismatch');
});

test('independent reconciliation detects changed payloads, grants and tags',async t=>{
 for(const [sql,code] of [["UPDATE records SET payload_json=json_set(payload_json,'$.bookingRef','LOST') WHERE kind='activity'",'verification_records_mismatch'],["UPDATE trip_grants SET role='admin' WHERE account_id='guest'",'verification_grants_mismatch'],["DELETE FROM record_tags WHERE companion_id='1'",'verification_tags_mismatch']]){
  const d=await db(t),source=fixture();await importPlan(d,buildImport(source));await d.prepare(sql).run();await assert.rejects(verifyData(d,source),e=>e.code===code);
 }
});

test('payload mismatch is caught even when the faulty import plan itself is self-consistent',async t=>{
 const d=await db(t),source=fixture(),plan=buildImport(source);const statement=plan.statements.find(s=>s.sql.startsWith('INSERT INTO records')&&s.params[1]==='activity');const payload=JSON.parse(statement.params[3]);delete payload.bookingRef;statement.params[3]=JSON.stringify(payload);
 await importPlan(d,plan);await assert.rejects(verifyData(d,source),e=>e.code==='verification_records_mismatch');
});

test('reserved extension collision and oversized records fail before remote import',()=>{
 const source=fixture(),trip=JSON.parse(source.entries['trip:trip1']);trip._legacyIndex={private:'keep'};source.entries['trip:trip1']=JSON.stringify(trip);assert.throws(()=>buildImport(source),/Reserved source field/);
 const plan=buildImport(fixture());plan.statements[0].params[2]='x'.repeat(260000);assert.throws(()=>batches(plan),e=>e.code==='record_exceeds_rehearsal_limit');
});

test('source export is read-only and detects drift without printing private contents',async()=>{
 const source=fixture(),calls=[];const api={async request(path,options={}){calls.push({path,...options});assert.equal(options.method,undefined);if(path.includes('/keys?'))return {result:Object.keys(source.entries).map(name=>({name})),result_info:{}};return source.entries[decodeURIComponent(path.split('/values/')[1])];}};
 const snapshot=await exportSnapshot(api,'a'.repeat(32));assert.deepEqual({...snapshot.entries},source.entries);assert(calls.length>Object.keys(source.entries).length);
 source.entries['trip:trip1']='sensitive changed payload';await assert.rejects(verifySourceStable(api,'a'.repeat(32),snapshot),e=>e.code==='source_changed'&&!e.message.includes('sensitive'));
});

test('REST adapter sends parameterized batches and suppresses private API errors',async()=>{
 const requests=[];const api=new Cloudflare('a'.repeat(32),'private-token',async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({success:true,result:[{success:true,results:[{n:1}]}]}),{status:200});});
 const d=new RemoteD1(api,'11111111-1111-4111-8111-111111111111');assert.equal((await d.prepare('SELECT ? AS n').bind(1).first()).n,1);assert.deepEqual(JSON.parse(requests[0].options.body),{batch:[{sql:'SELECT ? AS n',params:[1]}]});
 const denied=new Cloudflare('a'.repeat(32),'private-token',async()=>new Response('PRIVATE SQL AND TOKEN',{status:403}));
 await assert.rejects(denied.request('/storage/kv/namespaces'),e=>e.code==='cloudflare_token_permissions'&&!e.message.includes('PRIVATE'));
});

test('CLI failure summary never echoes private source values or keys',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const dir=await mkdtemp(join(tmpdir(),'waypoint-test-'));
 try{const source=fixture();source.entries.trip_index=JSON.stringify({trips:[{tripId:'SECRET_TRIP_ID',ownerId:'owner'}]});const file=join(dir,'source.json');await writeFile(file,JSON.stringify(source));
 const result=spawnSync(process.execPath,['scripts/backend-v1/rehearse.mjs','--local',file],{encoding:'utf8',env:{...process.env,GITHUB_STEP_SUMMARY:join(dir,'summary.md')}});assert.equal(result.status,1);assert(!result.stdout.includes('SECRET_TRIP_ID'));assert(!result.stdout.includes('private-hash'));const report=JSON.parse(result.stdout);assert.equal(report.status,'failed');assert.equal(report.code,'missing_source_key');assert.deepEqual(report.location,{source:'trip_content',tripNumber:1});const summary=await readFile(join(dir,'summary.md'),'utf8');assert(summary.includes('missing_source_key'));assert(!summary.includes('SECRET_TRIP_ID'));assert(!summary.includes('private-hash'));assert(!result.stderr.includes('SECRET_TRIP_ID'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('validation diagnostics identify malformed structures and references without source values',()=>{
 const cases=[
  ['invalid_trip_index',s=>s.entries.trip_index='null',{source:'trip_index'}],
  ['invalid_account_index',s=>s.entries.users='null',{source:'users'}],
  ['invalid_account',s=>edit(s,'users',u=>u.users[0]=null),{source:'users',accountNumber:1}],
  ['invalid_source_id',s=>edit(s,'users',u=>u.users[0].id='PRIVATE INVALID ID'),{source:'users',accountNumber:1,field:'id'}],
  ['duplicate_account_id',s=>edit(s,'users',u=>u.users.push(u.users[0])),{source:'users',accountNumber:6}],
  ['invalid_trip_entry',s=>edit(s,'trip_index',i=>i.trips[0]=null),{source:'trip_index',tripNumber:1}],
  ['missing_trip_owner',s=>edit(s,'trip_index',i=>i.trips[0].ownerId='PRIVATE_OWNER'),{source:'trip_index',tripNumber:1,field:'ownerId'}],
  ['invalid_source_json',s=>s.entries['trip:trip1']='PRIVATE INVALID JSON',{source:'trip_content',tripNumber:1}],
  ['invalid_record_collection',s=>edit(s,'trip:trip1',t=>t.activities={private:'data'}),{source:'trip_content',tripNumber:1,collection:'activities'}],
  ['invalid_record',s=>edit(s,'trip:trip1',t=>t.activities[0]=null),{source:'trip_content',tripNumber:1,collection:'activities',recordNumber:1}],
  ['duplicate_record_id',s=>edit(s,'trip:trip1',t=>t.activities[1].activityId=1),{source:'trip_content',tripNumber:1,collection:'activities',recordNumber:2,field:'activityId'}],
  ['invalid_participant_tags',s=>edit(s,'trip:trip1',t=>t.activities[0].companions='PRIVATE_TAG'),{source:'trip_content',tripNumber:1,collection:'activities',recordNumber:1,field:'companions'}],
  ['missing_record_participant',s=>edit(s,'trip:trip1',t=>t.activities[0].companions=[1,'PRIVATE_PARTICIPANT']),{source:'trip_content',tripNumber:1,collection:'activities',recordNumber:1,field:'companions',tagNumber:2}],
  ['missing_linked_account',s=>edit(s,'trip:trip1',t=>t.companions[0].accountId='PRIVATE_ACCOUNT'),{source:'trip_content',tripNumber:1,collection:'companions',recordNumber:1,field:'accountId'}],
  ['invalid_grant',s=>edit(s,'trip_index',i=>i.trips[0].grants[0]=null),{source:'trip_index',tripNumber:1,grantNumber:1}],
  ['missing_grant_account',s=>edit(s,'trip_index',i=>i.trips[0].grants[0].accountId='PRIVATE_ACCOUNT'),{source:'trip_index',tripNumber:1,grantNumber:1,field:'accountId'}],
  ['invalid_grant_role',s=>edit(s,'trip_index',i=>i.trips[0].grants[0].role='PRIVATE_ROLE'),{source:'trip_index',tripNumber:1,grantNumber:1,field:'role'}],
  ['missing_grant_participant',s=>edit(s,'trip_index',i=>i.trips[0].grants[0].companionId='PRIVATE_PARTICIPANT'),{source:'trip_index',tripNumber:1,grantNumber:1,field:'companionId'}],
  ['unindexed_trip_keys',s=>s.entries['trip:PRIVATE_ORPHAN']='{}',{source:'trip_index',count:1}]
 ];
 function edit(source,key,mutate){const value=JSON.parse(source.entries[key]);mutate(value);source.entries[key]=JSON.stringify(value);}
 for(const [code,mutate,location] of cases){const source=fixture();mutate(source);const before=JSON.stringify(source);assert.throws(()=>buildImport(source),e=>{assert.equal(e.code,code);assert.deepEqual(e.location,location);assert(!JSON.stringify(e).includes('PRIVATE'));assert(!e.message.includes('PRIVATE'));return true;});assert.equal(JSON.stringify(source),before);}
});
