import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonical,KINDS,META_FIELDS } from '../../src/backend-v1/protocol.js';
import { SyncStore } from '../../src/backend-v1/store.js';
import { check,RehearsalError } from './cloudflare.mjs';
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const bytes=value=>Buffer.byteLength(JSON.stringify(value));

export async function schemaStatements(){
 const sql=await readFile(new URL('../../migrations/backend-v1/0001_sync_foundation.sql',import.meta.url),'utf8');let statement='';const out=[];
 for(const line of sql.split('\n')){if(!line.trim()||line.trim().startsWith('--'))continue;statement+=line+'\n';if(statement.trim().startsWith('CREATE TRIGGER')?!/^END;$/.test(line.trim()):!line.trim().endsWith(';'))continue;out.push(statement);statement='';}
 check(!statement.trim(),'invalid_schema');return out;
}
export async function initializeRehearsal(db){
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").all();
 check(tables.results.length===0,'destination_not_empty');
 const schema=await schemaStatements();await db.batch(schema.map(sql=>db.prepare(sql)));
 await db.prepare("CREATE TABLE rehearsal_control(id INTEGER PRIMARY KEY CHECK(id=1),source_hash TEXT NOT NULL,plan_hash TEXT NOT NULL,next_batch INTEGER NOT NULL,state TEXT NOT NULL)").run();
}
export function batches(plan){
 check(plan.format==='waypoint-d1-import-plan-v1','invalid_plan');
 const statements=plan.statements.slice(0,-1);check(plan.statements.at(-1)?.sql.startsWith('INSERT INTO import_manifest'),'invalid_plan');
 const out=[];let batch=[],size=0;
 for(const s of statements){check(s.params.length<=100&&Buffer.byteLength(s.sql)<=100000&&bytes(s)<=250000,'record_exceeds_rehearsal_limit');if(batch.length>=20||size+bytes(s)>250000){out.push(batch);batch=[];size=0;}batch.push(s);size+=bytes(s);}
 if(batch.length)out.push(batch);return out;
}
export async function importPlan(db,plan){
 const chunks=batches(plan),planHash=digest(plan.statements);
 let control=await db.prepare('SELECT * FROM rehearsal_control WHERE id=1').first();
 if(!control){
   const counts=await db.prepare('SELECT (SELECT count(*) FROM trips)+(SELECT count(*) FROM records)+(SELECT count(*) FROM trip_grants)+(SELECT count(*) FROM import_manifest) AS n').first();
   check(counts.n===0,'destination_not_empty');
   await db.prepare("INSERT INTO rehearsal_control VALUES(1,?,?,0,'importing')").bind(plan.sourceHash,planHash).run();
   control={source_hash:plan.sourceHash,plan_hash:planHash,next_batch:0,state:'importing'};
 }
 check(control.source_hash===plan.sourceHash&&control.plan_hash===planHash,'resume_source_mismatch');
 check(Number.isInteger(control.next_batch)&&control.next_batch>=0&&control.next_batch<=chunks.length,'invalid_checkpoint');
 for(let index=control.next_batch;index<chunks.length;index++){
   // OR IGNORE permits replay after a lost response or partially applied REST
   // request. It never overwrites existing data; reconciliation detects mismatch.
   const commands=chunks[index].map(s=>db.prepare(s.sql.replace(/^INSERT INTO /,'INSERT OR IGNORE INTO ')).bind(...s.params));
   commands.push(db.prepare("UPDATE rehearsal_control SET next_batch=?,state='importing' WHERE id=1 AND source_hash=? AND plan_hash=?").bind(index+1,plan.sourceHash,planHash));
   try{await db.batch(commands);}catch{
     // Do not guess after an ambiguous response. A restart with this exact
     // snapshot resumes from the durable checkpoint and verifies every row.
     throw new RehearsalError('import_interrupted');
   }
 }
 return {batches:chunks.length,planHash};
}
async function rows(db,table){
 const out=[];let after=0;
 for(;;){const page=await db.prepare(`SELECT rowid AS _rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 25`).bind(after).all();if(!page.results.length)break;for(const row of page.results){after=row._rowid;const copy={...row};delete copy._rowid;out.push(copy);}}
 return out;
}
// Independent reconstruction from source JSON, not from the SQL plan being tested.
export function expectedData(snapshot){
 const index=JSON.parse(snapshot.entries.trip_index),expected={trips:[],records:[],grants:[],tags:[]};
 for(const entry of index.trips){
   const tripId=String(entry.tripId),content=JSON.parse(snapshot.entries['trip:'+tripId]);
   const meta={},extras={};for(const [key,value] of Object.entries(content)){if(META_FIELDS.includes(key))meta[key]=value;else if(!Object.values(KINDS).includes(key))extras[key]=value;}
   check(!Object.hasOwn(extras,'_legacyIndex'),'reserved_source_field');extras._legacyIndex=entry;
   expected.trips.push({id:tripId,owner_id:String(entry.ownerId),metadata_json:canonical(meta),legacy_extras_json:canonical(extras),revision:1,deleted:0,updated_at:'1970-01-01T00:00:00.000Z'});
   for(const [kind,list] of Object.entries(KINDS))for(const source of content[list]||[]){
     const data=structuredClone(source),recordId=String(data[kind+'Id']);data[kind+'Id']=recordId;
     for(const field of ['destinationId','contactId','accountId'])if(data[field]!==undefined&&data[field]!==null&&data[field]!=='')data[field]=String(data[field]);
     if(data.companions)data.companions=data.companions.map(String);
     expected.records.push({trip_id:tripId,kind,id:recordId,payload_json:canonical(data),revision:1,deleted:0,updated_at:'1970-01-01T00:00:00.000Z'});
     for(const companion of new Set(data.companions||[]))expected.tags.push({trip_id:tripId,kind,record_id:recordId,companion_id:companion});
   }
   for(const grant of entry.grants||[])expected.grants.push({trip_id:tripId,account_id:String(grant.accountId),role:grant.role,companion_id:grant.companionId?String(grant.companionId):''});
 }
 return expected;
}
function signature(rows){return digest(rows.map(canonical).sort());}
export async function verifyData(db,snapshot){
 const expected=expectedData(snapshot);
 for(const [key,table] of [['trips','trips'],['records','records'],['grants','trip_grants'],['tags','record_tags']])check(signature(await rows(db,table))===signature(expected[key]),'verification_'+key+'_mismatch');
 const events=await db.prepare('SELECT count(*) AS n FROM changes').first();check(events.n===expected.trips.length+expected.records.length,'verification_changes_mismatch');
 check((await db.prepare('SELECT count(*) AS n FROM mutation_receipts').first()).n===0,'unexpected_client_writes');
 check((await db.prepare('SELECT count(*) AS n FROM write_guards').first()).n===0,'unexpected_write_guards');
 return {trips:expected.trips.length,records:expected.records.length,grants:expected.grants.length,participantTags:expected.tags.length};
}
export async function verifyPermissions(db,snapshot){
 const expected=expectedData(snapshot),accounts=JSON.parse(snapshot.entries.users).users;
 const secret=crypto.randomUUID();let checks=0;
 for(const account of [...accounts,{id:'rehearsal-outsider-'+crypto.randomUUID(),isUberUser:false}]){
   const uid=String(account.id),visible=new Set();
   for(const trip of expected.trips){
     const grant=expected.grants.find(g=>g.trip_id===trip.id&&g.account_id===uid);
     const full=!!account.isUberUser||trip.owner_id===uid||grant?.role==='admin';if(!full&&!grant)continue;
     visible.add(trip.id+'|trip|'+trip.id);
     const records=expected.records.filter(r=>r.trip_id===trip.id),contacts=new Set();
     for(const r of records){const data=JSON.parse(r.payload_json);if(['activity','accommodation','transport'].includes(r.kind)&&(data.companions||[]).includes(grant?.companion_id)&&data.contactId)contacts.add(data.contactId);}
     for(const r of records){const data=JSON.parse(r.payload_json);if(full||r.kind==='companion'||(['destination','activity','transport','accommodation'].includes(r.kind)&&(data.companions||[]).includes(grant?.companion_id))||(r.kind==='contact'&&contacts.has(r.id)))visible.add(r.trip_id+'|'+r.kind+'|'+r.id);}
   }
   const store=new SyncStore(db,{id:uid,isUberUser:!!account.isUberUser},secret),actual=new Set();let cursor=null,complete=false;
   for(let pages=0;pages<10000;pages++){
     const page=await store.bootstrap(new URL('https://rehearsal.invalid/?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):'')));
     for(const entity of page.entities){actual.add(entity.tripId+'|'+entity.kind+'|'+entity.recordId);const trip=expected.trips.find(t=>t.id===entity.tripId),grant=expected.grants.find(g=>g.trip_id===entity.tripId&&g.account_id===uid);const full=account.isUberUser||trip.owner_id===uid||grant?.role==='admin';if(!full&&entity.kind==='companion')check(!Object.hasOwn(entity.data,'accountId'),'verification_identity_leak');}
     if(page.complete){complete=true;break;}cursor=page.nextCursor;
   }
   check(complete&&signature([...actual])===signature([...visible]),'verification_visibility_mismatch');checks++;
 }
 return {accountsChecked:checks-1,outsiderDenied:true};
}
export async function completeRehearsal(db,plan){
 await db.batch([
   db.prepare('INSERT OR IGNORE INTO import_manifest VALUES(1,?,?)').bind(plan.sourceHash,new Date().toISOString()),
   db.prepare("UPDATE rehearsal_control SET state='verified' WHERE id=1 AND source_hash=?").bind(plan.sourceHash),
 ]);
 const marker=await db.prepare('SELECT source_hash FROM import_manifest WHERE id=1').first();check(marker?.source_hash===plan.sourceHash,'manifest_mismatch');
}
