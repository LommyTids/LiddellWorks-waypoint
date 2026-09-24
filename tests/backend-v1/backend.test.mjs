import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncStore } from '../../src/backend-v1/store.js';
import { readCursor } from '../../src/backend-v1/protocol.js';
import worker from '../../src/backend-v1/worker.js';
import { SQLiteD1,MemoryKV } from './sqlite-d1.mjs';
import { buildImport } from '../../scripts/backend-v1/plan-import.mjs';

const secret='test-only-long-session-secret';
function env(t) { const db=new SQLiteD1();t.after(()=>db.close());return db; }
function store(db,uid='owner',uber=false){return new SyncStore(db,{id:uid,isUberUser:uber},secret);}
function change(kind='activity',recordId='activity1',operation='create',baseRevision=0,data={title:'Museum',companions:[]}) {
  return {mutationId:crypto.randomUUID(),tripId:'trip1',kind,recordId,operation,baseRevision,...(operation==='delete'?{}:{data})};
}
async function trip(db){await store(db).apply(change('trip','trip1','create',0,{name:'Sample trip',homeCurrency:'GBP'}));}
const url=(path='bootstrap',params='')=>new URL('https://example.test/WayPoint/api/v1/sync/'+path+params);
async function snapshot(s){const all=[];let page;do{page=await s.bootstrap(url('bootstrap',page?'?cursor='+encodeURIComponent(page.nextCursor):''));all.push(...page.entities);}while(!page.complete);return {...page,entities:all};}
async function grant(db,role='user'){
  await store(db).apply(change('companion','person1','create',0,{name:'Guest'}));
  await store(db).setGrant('trip1',{accountId:'guest',role,companionId:'person1'},[{id:'guest'}]);
}

test('create/update is per record; a duplicate retry changes nothing twice',async t=>{
  const db=env(t);await trip(db);const s=store(db);const first=change();
  assert.equal((await s.apply(first)).revision,1);assert.equal((await s.apply(first)).duplicate,true);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM changes WHERE kind='activity'").first()).n,1);
  assert.equal((await s.apply(change('activity','activity1','update',1,{notes:'New note'}))).revision,2);
  const item=(await snapshot(s)).entities.find(x=>x.kind==='activity');assert.equal(item.data.title,'Museum');assert.equal(item.data.notes,'New note');
  await assert.rejects(s.apply({...first,data:{title:'Different'}}),e=>e.code==='mutation_id_reused');
});
test('stale revision conflicts; unrelated record edits succeed',async t=>{
  const db=env(t);await trip(db);const s=store(db);await s.apply(change());await s.apply(change('activity','activity2'));
  await s.apply(change('activity','activity1','update',1,{title:'New'}));
  await assert.rejects(s.apply(change('activity','activity1','update',1,{title:'Old'})),e=>e.code==='revision_conflict');
  assert.equal((await s.apply(change('activity','activity2','update',1,{title:'Other'}))).revision,2);
});
test('transaction failure rolls back record, event, guard and receipt',async t=>{
  const db=env(t);await trip(db);const s=store(db);const request=change();
  const before=(await db.prepare('SELECT count(*) AS n FROM changes').first()).n;
  // context is first batch; inject failure in mutation batch after record insert.
  const original=db.batch.bind(db);db.batch=async list=>{if(list[0].sql.startsWith('INSERT INTO write_guards'))db.failAfter=2;return original(list);};
  await assert.rejects(s.apply(request),/Injected/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM records').first()).n,0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM changes').first()).n,before);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM write_guards').first()).n,0);
  assert.equal(await s.receipt(request,'anything'),null);
});
test('concurrent writers cannot both pass the same revision',async t=>{
  const db=env(t);await trip(db);const s=store(db);await s.apply(change());
  const results=await Promise.allSettled([s.apply(change('activity','activity1','update',1,{title:'A'})),s.apply(change('activity','activity1','update',1,{title:'B'}))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await db.prepare("SELECT revision FROM records WHERE kind='activity'").first()).revision,2);
});
test('scoped users see tagged items only; cannot create, delete, retag or self-promote',async t=>{
  const db=env(t);await trip(db);await grant(db);const s=store(db);const guest=store(db,'guest');
  await s.apply(change('activity','visible','create',0,{title:'Visible',companions:['person1']}));await s.apply(change('activity','hidden'));
  const items=(await snapshot(guest)).entities;assert(items.some(x=>x.recordId==='visible'));assert(!items.some(x=>x.recordId==='hidden'));
  await guest.apply(change('activity','visible','update',1,{notes:'Mine'}));
  for (const c of [change(),change('activity','visible','delete',2),change('activity','visible','update',2,{companions:[]}),change('activity','hidden','update',1,{title:'Stolen'})]) await assert.rejects(guest.apply(c),e=>e.status===403);
  await assert.rejects(guest.apply(change('trip','trip1','update',1,{name:'No'})),e=>e.status===403);
  await assert.rejects(guest.setGrant('trip1',{accountId:'guest',role:'admin'},[{id:'guest'}]),e=>e.status===403);
});
test('viewers cannot write; unauthorized accounts cannot read or mutate',async t=>{
  const db=env(t);await trip(db);await grant(db,'viewer');await store(db).apply(change('activity','activity1','create',0,{title:'Visible',companions:['person1']}));
  await assert.rejects(store(db,'guest').apply(change('activity','activity1','update',1,{title:'No'})),e=>e.status===403);
  assert.equal((await snapshot(store(db,'stranger'))).entities.length,0);
  await assert.rejects(store(db,'stranger').apply(change()),e=>e.status===404);
});
test('revocation and tag changes invalidate cursors, requiring cache replacement',async t=>{
  const db=env(t);await trip(db);await grant(db);await store(db).apply(change('activity','activity1','create',0,{title:'Visible',companions:['person1']}));
  const guest=store(db,'guest');const before=await snapshot(guest);
  await store(db).apply(change('activity','activity1','update',1,{companions:[]}));
  await assert.rejects(guest.changes(url('changes','?cursor='+encodeURIComponent(before.syncCursor))),e=>e.code==='bootstrap_required');
  assert(!(await snapshot(guest)).entities.some(x=>x.kind==='activity'));
  const next=await snapshot(guest);await store(db).setGrant('trip1',{accountId:'guest',role:null},[{id:'guest'}]);
  await assert.rejects(guest.changes(url('changes','?cursor='+encodeURIComponent(next.syncCursor))),e=>e.code==='bootstrap_required');
  assert.equal((await snapshot(guest)).entities.length,0);
});
test('deleted records produce tombstones; record IDs cannot be reused',async t=>{
  const db=env(t);await trip(db);const s=store(db);await s.apply(change());const before=await snapshot(s);
  const deletion=change('activity','activity1','delete',1);await s.apply(deletion);assert.equal((await s.apply(deletion)).duplicate,true);
  const delta=await s.changes(url('changes','?cursor='+encodeURIComponent(before.syncCursor)));
  assert.equal(delta.entities[0].operation,'delete');assert.equal(delta.entities[0].data,undefined);
  await assert.rejects(s.apply(change()),e=>e.code==='already_exists');
});
test('bootstrap pages are atomic snapshots and restart if data changes',async t=>{
  const db=env(t);await trip(db);const s=store(db);await s.apply(change());
  const page=await s.bootstrap(url('bootstrap','?limit=1'));assert.equal(page.complete,false);assert.equal(page.syncCursor,null);
  await s.apply(change('activity','activity2'));
  await assert.rejects(s.bootstrap(url('bootstrap','?cursor='+encodeURIComponent(page.nextCursor))),e=>e.code==='bootstrap_required');
});
test('cursor tampering and account replay are rejected',async t=>{
  const db=env(t);await trip(db);const before=await snapshot(store(db));
  await assert.rejects(readCursor(before.syncCursor,secret,'guest','changes'),e=>e.code==='invalid_cursor');
  await assert.rejects(readCursor('x'+before.syncCursor,secret,'owner','changes'),e=>e.code==='invalid_cursor');
  await assert.rejects(store(db).changes(url('changes','?cursor='+encodeURIComponent(before.syncCursor)+'&limit=1000')),e=>e.code==='invalid_limit');
});
test('dates, coordinate pairs, identity and server-owned fields are validated',async t=>{
  const db=env(t);await trip(db);const s=store(db);
  for (const data of [{startDate:'2026-02-30'},{startTime:'25:00'},{addressLat:90},{addressLat:91,addressLng:0},{ownerId:'guest'},{activityId:'wrong'}]) await assert.rejects(s.apply(change('activity','activity1','create',0,data)),e=>e.status===400);
  await assert.rejects(s.apply(change('companion','person1','create',0,{name:'Person',accountId:'owner'})),e=>e.status===400);
});
test('mixed batch returns explicit outcomes without hiding an earlier success',async t=>{
  const db=env(t);await trip(db);const s=store(db);
  const result=await s.mutations({protocolVersion:1,mutations:[change(),change()]});
  assert.deepEqual(result.results.map(x=>x.status),['applied','conflict']);
});
test('HTTP uses real cookie auth and denies cross-origin writes and old data routes',async t=>{
  const db=env(t);const environment={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:new MemoryKV(),WAYPOINT_PASSWORD:'setup-secret',WAYPOINT_SESSION_SECRET:secret};
  const call=(path,options={})=>worker.fetch(new Request('https://staging.test/WayPoint/api/'+path,options),environment,{});
  assert.equal((await call('v1/sync/bootstrap')).status,401);
  const setup=await call('setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupKey:'setup-secret',username:'testowner',password:'password123'})});
  assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('v1/sync/bootstrap',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await call('data',{headers:{Cookie:cookie}})).status,404);
  assert.equal((await call('v1/trips',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await worker.fetch(new Request('https://staging.test/WayPoint/api/v1/trips'),{...environment,WAYPOINT_ENV:'production'},{})).status,503);
});

function backup() {
  const content={name:'Import example',startDate:'2026-09-24',endDate:'2026-09-27',homeCurrency:'GBP',notes:'Keep me',_revision:8,
    companions:[{companionId:1,name:'Guest',accountId:'guest'}],activities:[{activityId:1,title:'Museum',companions:[1],bookingRef:'private-ref',futureField:{keep:true}}],
    destinations:[],transport:[],accommodation:[],contacts:[],expenses:[{expenseId:'e1',description:'Keep expense',amount:'25'}],geocodeCache:{},futureTripField:'keep'};
  return {format:'waypoint-kv-export-v1',entries:{users:JSON.stringify({users:[{id:'owner'},{id:'guest'}]}),trip_index:JSON.stringify({trips:[{tripId:'trip1',ownerId:'owner',grants:[{accountId:'guest',role:'user',companionId:1}]}]}),'trip:trip1':JSON.stringify(content)}};
}
test('migration preserves private fields, numeric IDs, tags, expenses and extensions',async t=>{
  const db=env(t);const input=backup();const plan=buildImport(input);
  assert.deepEqual(buildImport(input),plan);assert.equal(plan.counts.records,3);
  await db.batch(plan.statements.map(x=>db.prepare(x.sql).bind(...x.params)));
  const row=await db.prepare("SELECT payload_json FROM records WHERE kind='activity'").first();const data=JSON.parse(row.payload_json);
  assert.equal(data.activityId,'1');assert.deepEqual(data.companions,['1']);assert.equal(data.bookingRef,'private-ref');assert.deepEqual(data.futureField,{keep:true});
  const extras=JSON.parse((await db.prepare('SELECT legacy_extras_json FROM trips').first()).legacy_extras_json);assert.equal(extras._revision,8);assert.equal(extras.futureTripField,'keep');
  const scoped=await snapshot(store(db,'guest'));assert(!scoped.entities.some(x=>x.kind==='expense'));assert.equal(scoped.entities.find(x=>x.kind==='companion').data.accountId,undefined);
  const counts=(await db.prepare('SELECT count(*) AS n FROM records').first()).n;
  await assert.rejects(db.batch(plan.statements.map(x=>db.prepare(x.sql).bind(...x.params))));assert.equal((await db.prepare('SELECT count(*) AS n FROM records').first()).n,counts);
});
test('migration refuses missing source, orphan owners, duplicate IDs and dangling tags',()=>{
  const noKey=backup();delete noKey.entries['trip:trip1'];assert.throws(()=>buildImport(noKey),/Missing source/);
  const owner=backup();owner.entries.users=JSON.stringify({users:[{id:'guest'}]});assert.throws(()=>buildImport(owner),/owner/);
  const duplicate=backup();const content=JSON.parse(duplicate.entries['trip:trip1']);content.activities.push({...content.activities[0],activityId:'1'});duplicate.entries['trip:trip1']=JSON.stringify(content);assert.throws(()=>buildImport(duplicate),/Duplicate record/);
  const tags=backup();const tagged=JSON.parse(tags.entries['trip:trip1']);tagged.activities[0].companions=['missing'];tags.entries['trip:trip1']=JSON.stringify(tagged);assert.throws(()=>buildImport(tags),/missing participant/);
});

test('scoped users cannot expose a hidden contact by guessing its ID',async t=>{
  const db=env(t);await trip(db);await grant(db);const s=store(db);
  await s.apply(change('contact','secret','create',0,{name:'Private contact'}));
  await s.apply(change('activity','visible','create',0,{title:'Visible',companions:['person1']}));
  await assert.rejects(store(db,'guest').apply(change('activity','visible','update',1,{contactId:'secret'})),e=>e.code==='invalid_reference');
  const before=await snapshot(store(db,'guest'));
  await s.apply(change('activity','linked','create',0,{title:'Linked',companions:['person1'],contactId:'secret'}));
  await assert.rejects(store(db,'guest').changes(url('changes','?cursor='+encodeURIComponent(before.syncCursor))),e=>e.code==='bootstrap_required');
  assert((await snapshot(store(db,'guest'))).entities.some(x=>x.recordId==='secret'));
});
test('referenced participants cannot be deleted; missing references are rejected',async t=>{
  const db=env(t);await trip(db);await grant(db);const s=store(db);
  await assert.rejects(s.apply(change('companion','person1','delete',1)),e=>e.code==='participant_in_use');
  await assert.rejects(s.apply(change('activity','bad','create',0,{title:'Bad',companions:['missing']})),e=>e.code==='invalid_reference');
  await s.setGrant('trip1',{accountId:'guest',role:null},[{id:'guest'}]);
  assert.equal((await s.apply(change('companion','person1','delete',1))).revision,2);
});
