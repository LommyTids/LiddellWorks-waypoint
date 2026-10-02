import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import worker from '../../src/worker.js';
import { LocalD1 } from '../../scripts/backend-v1/local-d1.mjs';
import { Cloudflare } from '../../scripts/backend-v1/cloudflare.mjs';
import { canonical } from '../../src/backend-v1/protocol.js';
import { encryptBackup,decryptBackup,retainBackup,readRetainedBackup,sha256,backupParts } from '../../scripts/backend-v1/migration-backup.mjs';
import { assertPaused,settlePausedSource,assertDistinctResources,SOURCE_STATUS } from '../../scripts/backend-v1/migration-control.mjs';
import { prepareProduction } from '../../scripts/backend-v1/prepare-production.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const SOURCE='1'.repeat(32),BACKUP='2'.repeat(32),staging={kvNamespaceId:'3'.repeat(32),databaseId:'11111111-1111-4111-8111-111111111111'},DEST='22222222-2222-4222-8222-222222222222',freezeId='test-freeze-2026';
function fixture(){return {format:'waypoint-kv-export-v1',namespaceId:SOURCE,entries:{users:JSON.stringify({users:[{id:'owner',username:'PRIVATE_NAME',passwordHash:'PRIVATE_HASH'},{id:'guest',username:'PRIVATE_GUEST'}]}),users_initialized:'1',trip_index:JSON.stringify({trips:[{tripId:'t1',ownerId:'owner',grants:[{accountId:'guest',role:'viewer',companionId:'p1'}]}]}),'trip:t1':JSON.stringify({name:'PRIVATE_TRIP',companions:[{companionId:'p1',name:'PRIVATE_PERSON',accountId:'guest'}],activities:[{activityId:'a1',title:'PRIVATE_ACTIVITY',companions:['p1','__trip_superuser__']}]})}};}
const hash=s=>sha256(canonical(s.entries));
const pausedFetch=async()=>new Response(JSON.stringify({storage:'kv',writesPaused:true,freezeId}));
function fakeCloudflare(t,source=fixture(),options={}){
 const db=new LocalD1();t.after(()=>db.close());const values=new Map(),calls=[];
 const api={account:'a'.repeat(32),async request(path,opts={}){
  calls.push({path,...opts});
  if(path==='/storage/kv/namespaces'&&opts.method==='POST')return {result:{id:options.backupAlias||BACKUP,title:opts.body.title}};
  if(path==='/d1/database'&&opts.method==='POST')return {result:{uuid:DEST,name:opts.body.name}};
  if(path==='/d1/database/'+DEST+'/query')return {result:await db.batch(opts.body.batch.map(s=>db.prepare(s.sql).bind(...s.params)))};
  const match=/^\/storage\/kv\/namespaces\/([^/]+)\/(keys|values)(?:\/(.*))?/.exec(path);assert(match,'Unexpected API route');const [,namespace,kind,encoded]=match;
  if(namespace===SOURCE){assert(!opts.method||opts.method==='GET','Source must stay read-only');if(kind==='keys')return {result:Object.keys(source.entries).map(name=>({name})),result_info:{}};return source.entries[decodeURIComponent(encoded)];}
  assert.equal(namespace,BACKUP);const key=decodeURIComponent(encoded);
  if(opts.method==='PUT'){if(options.failBackup)throw Error('PRIVATE_PROVIDER_ERROR');values.set(key,opts.textBody);return {success:true};}
  const value=values.get(key);return options.corruptBackup&&key.includes(':chunk:')?value+'tampered':value;
 }};
 return {api,db,values,calls,source,options:{api,readApi:api,source:SOURCE,staging,freezeId,expectedHash:hash(source),publicKey:keys.publicKey,fetcher:pausedFetch,wait:async()=>{}}};
}

test('pause blocks all non-read API requests before auth or KV access',async()=>{
 let touches=0;const kv={get:async()=>{touches++;return null;},put:async()=>{touches++;},delete:async()=>{touches++;}};
 const env={WAYPOINT_KV:kv,WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_FREEZE_ID:freezeId};
 for(const path of ['data','login','logout','setup','users','users/delete','trip-grants','trip-grants/revoke','companions/link','account/avatar','location-boundaries','v1/sync/mutations']){
  const r=await worker.fetch(new Request('https://test/WayPoint/api/'+path,{method:'POST',body:'not JSON'}),env,{});assert.equal(r.status,503,path);
 }
 const status=await worker.fetch(new Request(SOURCE_STATUS),env,{});assert.deepEqual(await status.json(),{storage:'kv',writesPaused:true,freezeId});assert.equal(status.headers.get('Cache-Control'),'no-store');assert.equal(touches,0);
});

test('paused GET cannot lazily write a legacy migration or provider cache',async()=>{
 // Bootstrap a real account so the GET reaches the old lazy migration path.
 const values=new Map();let writes=0;
 const kv={get:async k=>values.get(k)??null,put:async(k,v)=>{writes++;values.set(k,v);},delete:async k=>{writes++;values.delete(k);}};
 const env={WAYPOINT_KV:kv,WAYPOINT_PASSWORD:'setup-key',WAYPOINT_SESSION_SECRET:'migration-test-secret',ASSETS:{fetch:async()=>new Response('asset')}};
 const setup=await worker.fetch(new Request('https://test/WayPoint/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupKey:'setup-key',username:'owner',password:'test-password-123'})}),env,{});assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];
 const before=writes;env.WAYPOINT_WRITES_PAUSED='true';env.WAYPOINT_FREEZE_ID=freezeId;
 const whoami=await worker.fetch(new Request('https://test/WayPoint/api/whoami',{headers:{Cookie:cookie}}),env,{});assert.equal(whoami.status,200);
 const get=await worker.fetch(new Request('https://test/WayPoint/api/data',{headers:{Cookie:cookie}}),env,{});assert.equal(get.status,503);assert.equal(writes,before);assert.equal(values.has('trip_index'),false);
 env.WAYPOINT_WRITES_PAUSED='false';const resumed=await worker.fetch(new Request('https://test/WayPoint/api/data',{headers:{Cookie:cookie}}),env,{});assert.equal(resumed.status,200);assert(writes>before);
});

test('encrypted backup recovers exact private source; wrong keys and tampering fail closed',()=>{
 const source=fixture(),envelope=encryptBackup(source,keys.publicKey);assert(!JSON.stringify(envelope).includes('PRIVATE_'));assert.deepEqual(decryptBackup(envelope,keys.privateKey),source);
 assert.throws(()=>decryptBackup({...envelope,tag:Buffer.alloc(16).toString('base64')},keys.privateKey),e=>e.code==='backup_decryption_failed');
 assert.throws(()=>decryptBackup({...envelope,keyFingerprint:'f'.repeat(64)},keys.privateKey),e=>e.code==='backup_key_mismatch');
 assert.throws(()=>encryptBackup(source,'PRIVATE_INVALID_KEY'),e=>e.code==='backup_encryption_failed'&&!e.message.includes('PRIVATE'));
 const large={...envelope,ciphertext:'A'.repeat(5*1024*1024)};assert.equal(backupParts(large,'test-backup').parts.length,2);
});

test('retained backup stores only encrypted values and independently verifies retained bytes',async t=>{
 const f=fakeCloudflare(t),envelope=encryptBackup(f.source,keys.publicKey),manifest=await retainBackup(f.api,BACKUP,envelope,'test-backup');
 assert.deepEqual(await readRetainedBackup(f.api,BACKUP,manifest),envelope);
 assert([...f.values.values()].every(v=>!v.includes('PRIVATE_')));assert(f.calls.filter(c=>c.method==='PUT').every(c=>!('expiration' in c)&&!('body' in c)));
 const first=manifest.chunks[0].key;f.values.set(first,f.values.get(first)+'tampered');await assert.rejects(readRetainedBackup(f.api,BACKUP,manifest),e=>e.code==='backup_chunk_mismatch');
});

test('pause verification checks live storage and exact marker throughout settling',async()=>{
 const waits=[];await settlePausedSource(freezeId,async ms=>waits.push(ms),pausedFetch);assert.deepEqual(waits,[40000,40000,40000]);
 for(const status of [{storage:'d1',writesPaused:true,freezeId},{storage:'kv',writesPaused:false,freezeId},{storage:'kv',writesPaused:true,freezeId:'another-freeze'}])await assert.rejects(assertPaused(freezeId,async()=>new Response(JSON.stringify(status))),e=>e.code==='source_not_paused');
 await assert.rejects(assertPaused(freezeId,async()=>new Response('PRIVATE HTML')) ,e=>e.code==='source_pause_invalid_response');
 assert.throws(()=>assertDistinctResources(SOURCE,staging,SOURCE),e=>e.code==='backup_isolation_failed');assert.throws(()=>assertDistinctResources(SOURCE,staging,BACKUP,staging.databaseId),e=>e.code==='destination_isolation_failed');
});

test('final preparation retains backup before importing an empty candidate and never switches production',async t=>{
 const f=fakeCloudflare(t),reports=[];
 const report=await prepareProduction({...f.options,onReport:r=>reports.push(r)});assert.equal(report.status,'prepared');assert.equal(report.sourceWrites,0);assert.equal(report.productionSwitch,false);assert.equal(report.databaseId,DEST);assert.equal(report.counts.records,2);assert.deepEqual(report.permissions,{accountsChecked:2,outsiderDenied:true});
 assert.equal((await f.db.prepare('SELECT state FROM rehearsal_control WHERE id=1').first()).state,'verified');
 const backupRead=f.calls.findIndex(c=>c.path.includes(':manifest')||c.path.includes('%3Amanifest'));const create=f.calls.findIndex(c=>c.path==='/d1/database');assert(backupRead>=0&&backupRead<create);
 assert(!JSON.stringify(reports).includes('PRIVATE_'));assert(!f.calls.some(c=>c.path.includes('/workers/')));
 const manifest=report.backup;assert.deepEqual(decryptBackup(await readRetainedBackup(f.api,BACKUP,manifest),keys.privateKey).entries,f.source.entries);
});

test('missing pause, source drift, unsafe backup destination and failed retention refuse database creation',async t=>{
 for(const mode of ['unpaused','changed_hash','alias','backup_failure','backup_corrupt']){
  const f=fakeCloudflare(t,fixture(),{backupAlias:mode==='alias'?SOURCE:undefined,failBackup:mode==='backup_failure',corruptBackup:mode==='backup_corrupt'}),reports=[];
  const options={...f.options,onReport:r=>reports.push(r),...(mode==='unpaused'?{fetcher:async()=>new Response(JSON.stringify({storage:'kv',writesPaused:false,freezeId}))}:{}),...(mode==='changed_hash'?{expectedHash:'0'.repeat(64)}:{})};
  await assert.rejects(prepareProduction(options));assert.equal(f.calls.some(c=>c.path==='/d1/database'),false,mode);assert.equal(reports.at(-1).status,'failed');assert(!JSON.stringify(reports).includes('PRIVATE_'));
 }
});

test('losing the pause after import leaves the candidate unverified and never resumes source writes',async t=>{
 const f=fakeCloudflare(t),reports=[];let lost=false;
 await assert.rejects(prepareProduction({...f.options,onReport:r=>{reports.push(r);if(r.phase==='verify_source_still_frozen')lost=true;},fetcher:async()=>new Response(JSON.stringify({storage:'kv',writesPaused:!lost,freezeId}))}),e=>e.code==='source_not_paused');
 assert.equal((await f.db.prepare('SELECT count(*) AS n FROM import_manifest').first()).n,0);assert.equal(reports.at(-1).databaseId,DEST);assert.equal(reports.at(-1).productionSwitch,false);
});

test('REST KV backup writes use text bodies and error summaries never echo provider data',async()=>{
 let request;
 const api=new Cloudflare('a'.repeat(32),'PRIVATE_TOKEN',async(url,options)=>{request=options;return new Response(JSON.stringify({success:true,result:null}));});
 await api.request('/storage/kv/namespaces/'+BACKUP+'/values/test',{method:'PUT',textBody:'encrypted-data'});assert.equal(request.body,'encrypted-data');assert.equal(request.headers['Content-Type'],'text/plain; charset=utf-8');
});

test('workflow exposes no automatic deployment, plaintext artifact or unfreeze',async()=>{
 const workflow=await readFile('.github/workflows/backend-production-prepare.yml','utf8');assert(workflow.includes('environment: waypoint-production'));assert(workflow.includes('source.encrypted.json'));assert(!workflow.includes('wrangler deploy'));assert(!workflow.includes('source.private'));assert(!workflow.includes('private.pem'));
});


test('production workflow uses runner context only after a runner is assigned',async()=>{
 const workflow=await readFile('.github/workflows/backend-production-prepare.yml','utf8');
 const jobConfiguration=workflow.split('    steps:')[0];
 assert(!jobConfiguration.includes('${{ runner.'),'runner context is unavailable in job-level env');
 const prepareStep=workflow.split('      - name: Verify pause, retain encrypted backup, import and verify candidate')[1].split('      - name:')[0];
 assert(prepareStep.includes('        env:\n          WAYPOINT_BACKUP_OUTPUT_DIR: ${{ runner.temp }}/waypoint-encrypted-backup'));
});


test('pause request failures distinguish HTTP, redirects, parsing and network without leaking responses',async()=>{
 for(const [status,code] of [[403,'source_pause_http_403'],[404,'source_pause_http_404'],[503,'source_pause_http_503'],[301,'source_pause_redirect'],[302,'source_pause_redirect']]){
  await assert.rejects(assertPaused(freezeId,async(url,options)=>{assert.equal(options.redirect,'manual');return new Response('PRIVATE_RESPONSE_BODY',{status,headers:{Location:'https://private.invalid/PRIVATE_TOKEN'}});}),e=>e.code===code&&!e.message.includes('PRIVATE'));
 }
 await assert.rejects(assertPaused(freezeId,async()=>{throw new Error('PRIVATE_NETWORK_DETAIL');}),e=>e.code==='source_pause_network_error'&&!e.message.includes('PRIVATE'));
 await assert.rejects(assertPaused(freezeId,async()=>{const e=new Error('PRIVATE_TIMEOUT_DETAIL');e.name='TimeoutError';throw e;}),e=>e.code==='source_pause_timeout'&&!e.message.includes('PRIVATE'));
 await assert.rejects(assertPaused(freezeId,async()=>new Response('null')),e=>e.code==='source_not_paused');
});

test('preview preflight reconciles the exact verified candidate and retained backup using read-only requests',async t=>{
 const {verifyPreview,previewConfiguration}=await import('../../scripts/backend-v1/production-preview.mjs');
 const f=fakeCloudflare(t),prepared=await prepareProduction(f.options);
 const pins={accountId:f.api.account,kvNamespaceId:SOURCE,databaseId:DEST,databaseName:prepared.databaseName,sourceHash:prepared.sourceHash,freezeId,backupNamespaceId:BACKUP,backupId:prepared.backup.backupId,encryptedSha256:prepared.backup.encryptedSha256,keyFingerprint:prepared.backup.keyFingerprint};
 const api={account:f.api.account,request:(path,options)=>path==='/d1/database/'+DEST?Promise.resolve({result:{uuid:DEST,name:prepared.databaseName}}):f.api.request(path,options)};
 f.calls.length=0;
 const result=await verifyPreview({api,readApi:api,pins,fetcher:pausedFetch});assert.equal(result.status,'preview_preflight_passed');assert.equal(result.destinationWrites,0);
 assert(f.calls.every(c=>!c.method||c.method==='GET'||(c.path.endsWith('/query')&&c.body.batch.every(s=>s.sql.startsWith('SELECT')))));
 assert.equal(previewConfiguration(pins).vars.WAYPOINT_WRITES_PAUSED,'true');
 assert.equal(previewConfiguration(pins).d1_databases[0].database_id,DEST);
 await assert.rejects(verifyPreview({api,readApi:api,pins:{...pins,encryptedSha256:'0'.repeat(64)},fetcher:pausedFetch}),e=>e.code==='backup_identity_mismatch');
 await f.db.prepare("UPDATE records SET revision=2").run();
 await assert.rejects(verifyPreview({api,readApi:api,pins,fetcher:pausedFetch}),e=>e.code==='verification_records_mismatch');
});

test('production browser uses D1 adapter and never exposes the dummy-trip setup page',async()=>{
 const sync=(await import('../../src/backend-v1/worker.js')).default;
 const env={WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_SOURCE_HASH:'a'.repeat(64),WAYPOINT_FREEZE_ID:freezeId,WAYPOINT_SESSION_SECRET:'test-secret',WAYPOINT_KV:{get:async()=>null},WAYPOINT_DB:{prepare:()=>({first:async()=>({source_hash:'a'.repeat(64),state:'verified'})})},ASSETS:{fetch:async()=>new Response('<title>Waypoint</title><body><script src="/WayPoint/js/boot.js"></script>')}};
 const page=await sync.fetch(new Request('https://test/WayPoint/'),env,{});const html=await page.text();assert.equal(page.status,200);assert(html.includes('Migration preview'));assert(html.includes('d1-client.js'));assert(!html.includes('Test trips only'));
 for(const path of ['/WayPoint/setup','/WayPoint/staging.js','/WayPoint/api/data'])assert.equal((await sync.fetch(new Request('https://test'+path),env,{})).status,404);
 const unpaused=await sync.fetch(new Request('https://test/WayPoint/'),{...env,WAYPOINT_WRITES_PAUSED:'false'},{});assert.equal(unpaused.status,503);
});
