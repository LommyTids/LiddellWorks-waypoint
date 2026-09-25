import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { SQLiteD1 } from './sqlite-d1.mjs';
import { SyncStore } from '../../src/backend-v1/store.js';
import { presentation,setAccess } from '../../src/backend-v1/web.js';
import { KINDS,META_FIELDS } from '../../src/backend-v1/protocol.js';
import { ITEM_FIELDS } from '../../src/worker.js';
const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../../public/WayPoint/staging/d1-client.js',import.meta.url),'utf8'),context);
const schema={kinds:KINDS,fields:ITEM_FIELDS,metadata:META_FIELDS};
const users={users:[{id:'owner',username:'Owner'},{id:'guest',username:'Guest'}]};
const secret='test-secret';
function store(db,who='owner'){return new SyncStore(db,{id:who,isUberUser:false},secret);}
function client(db,who='owner',intercept){const s=store(db,who);return context.WaypointD1.createClient(schema,async(path,body)=>{
 const url=new URL('https://staging.test/WayPoint/api/'+path);let value;
 if(path.startsWith('v1/web/presentation'))value=await presentation(s,users,url.searchParams.get('cursor'));
 else if(path.startsWith('v1/sync/bootstrap'))value=await s.bootstrap(url);
 else if(path==='v1/sync/mutations')value=await s.mutations(body);
 else throw Error('Unexpected path '+path);
 if(intercept)await intercept(path,body,value);return value;
},()=>crypto.randomUUID());}
const emptyTrip=()=>({tripId:'trip1',name:'Web test',homeCurrency:'GBP',startDate:'',endDate:'',notes:'',currencyRates:{},companions:[{companionId:'person1',name:'Guest'}],destinations:[],activities:[{activityId:'activity1',title:'Museum',companions:[]}],transport:[],accommodation:[],contacts:[],expenses:[]});
const copy=x=>JSON.parse(JSON.stringify(x));
function database(t){const db=new SQLiteD1();t.after(()=>db.close());return db;}
test('web adapter persists record changes, safely retries lost responses and never rewrites untouched records',async t=>{
 const db=database(t);let dropped=false;
 const a=client(db,'owner',(path,body)=>{if(!dropped&&body?.mutations[0].kind==='activity'){dropped=true;throw new TypeError('lost response');}});
 await a.load('owner');const first=await a.save({trips:[emptyTrip()]},'owner');assert.equal(first.trips[0].activities[0].title,'Museum');
 assert.equal((await db.prepare("SELECT count(*) AS n FROM changes WHERE kind='activity'").first()).n,1);
 const b=client(db);const stale=await b.load('owner');const edit=copy(first);edit.trips[0].activities[0].title='New museum';await a.save(edit,'owner');
 stale.trips[0].notes='Independent trip metadata';const fresh=await b.save(stale,'owner');assert.equal(fresh.trips[0].activities[0].title,'New museum');assert.equal(fresh.trips[0].notes,'Independent trip metadata');
});
test('two browser clients conflict on the same record; partial saves are explicit and reloadable',async t=>{
 const db=database(t),a=client(db),b=client(db);await a.load('owner');await a.save({trips:[emptyTrip()]},'owner');
 const left=await a.load('owner'),right=await b.load('owner');left.trips[0].activities[0].title='A';await a.save(left,'owner');
 right.trips[0].notes='Metadata committed first';right.trips[0].activities[0].title='B';await assert.rejects(b.save(right,'owner'),e=>e.code==='revision_conflict');
 const fresh=await b.load('owner');assert.equal(fresh.trips[0].notes,'Metadata committed first');assert.equal(fresh.trips[0].activities[0].title,'A');
});
test('web sharing links account and grant atomically; scoped refresh never exposes hidden records or private grants',async t=>{
 const db=database(t),a=client(db);await a.load('owner');const input=emptyTrip();input.activities.push({activityId:'visible',title:'Shared',companions:['person1']});await a.save({trips:[input]},'owner');
 await setAccess(store(db),{tripId:'trip1',companionId:'person1',username:'Guest',role:'user',baseRevision:1},users);
 const g=client(db,'guest');const view=await g.load('guest');assert.deepEqual(Array.from(view.trips[0].activities,x=>x.activityId),['visible']);assert.equal(view.trips[0].grants,undefined);assert.equal(view.trips[0].companions[0].accountId,undefined);
 view.trips[0].activities[0].notes='Guest edit';await g.save(view,'guest');assert.equal((await a.load('owner')).trips[0].activities.length,2);
 await assert.rejects(setAccess(store(db,'guest'),{tripId:'trip1',companionId:'person1',username:'Guest',role:'admin',baseRevision:2},users),e=>e.status===403);
 await setAccess(store(db),{tripId:'trip1',companionId:'person1',username:'Guest',role:'',baseRevision:2},users);
 assert.equal((await g.load('guest')).trips.length,0);
});
test('web sharing failure rolls back participant identity and grants',async t=>{
 const db=database(t),a=client(db);await a.load('owner');await a.save({trips:[emptyTrip()]},'owner');
 const batch=db.batch.bind(db);db.batch=async statements=>{if(statements[0].sql.startsWith('INSERT INTO write_guards'))db.failAfter=2;return batch(statements);};
 await assert.rejects(setAccess(store(db),{tripId:'trip1',companionId:'person1',username:'Guest',role:'user',baseRevision:1},users));
 assert.equal((await db.prepare('SELECT count(*) AS n FROM trip_grants').first()).n,0);assert.equal(JSON.parse((await db.prepare("SELECT payload_json FROM records WHERE kind='companion'").first()).payload_json).accountId,undefined);
});
test('deleting a visible trip creates one tombstone without deleting any other trip',async t=>{
 const db=database(t),a=client(db);await a.load('owner');const one=emptyTrip(),two={...emptyTrip(),tripId:'trip2'};await a.save({trips:[one,two]},'owner');const view=await a.load('owner');view.trips=view.trips.filter(t=>t.tripId!=='trip1');await a.save(view,'owner');assert.equal((await db.prepare("SELECT deleted FROM trips WHERE id='trip1'").first()).deleted,1);assert.equal((await db.prepare("SELECT deleted FROM trips WHERE id='trip2'").first()).deleted,0);
});
