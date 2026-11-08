// Deleting your own account. Apple is a local stand-in that checks the client
// secret's real signature against a locally made key. No test reaches Apple.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/backend-v1/worker.js';
import legacyWorker from '../../src/worker.js';
import { SyncStore } from '../../src/backend-v1/store.js';
import { setAccess } from '../../src/backend-v1/web.js';
import { SQLiteD1,MemoryKV } from './sqlite-d1.mjs';

const secret='test-only-long-session-secret';
const appleWeb='com.example.waypoint.web',appleApp='com.example.waypoint';

const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const der=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
const p8=`-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;

const part=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const apple={calls:[],sub:'apple-guest',exchange:200,revoke:200,down:false,onRevoke:null};
globalThis.fetch=async(url,options={})=>{
  if(apple.down)throw new TypeError('Network down');
  const form=new URLSearchParams(options.body);
  apple.calls.push({url:String(url),form});
  if(String(url)==='https://appleid.apple.com/auth/token'){
    if(apple.exchange!==200)return Response.json({error:'invalid_grant'},{status:apple.exchange});
    return Response.json({access_token:'secret-access',refresh_token:'secret-refresh',id_token:`${part({alg:'RS256'})}.${part({sub:apple.sub})}.unchecked`});
  }
  if(String(url)==='https://appleid.apple.com/auth/revoke'){
    await apple.onRevoke?.();
    return apple.revoke===200?new Response(''):Response.json({error:'invalid_client'},{status:apple.revoke});
  }
  throw new Error('Unexpected request: '+url);
};
test.beforeEach(()=>Object.assign(apple,{calls:[],sub:'apple-guest',exchange:200,revoke:200,down:false,onRevoke:null}));

const cookieFrom=response=>response.headers.get('set-cookie')?.split(';')[0]??null;
let nextAddress=0;
async function site(t,overrides={}) {
  const db=new SQLiteD1();t.after(()=>db.close());
  const kv=new MemoryKV();
  const env={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:kv,WAYPOINT_PASSWORD:'setup-secret',WAYPOINT_SESSION_SECRET:secret,
    WAYPOINT_APPLE_CLIENT_IDS:`${appleWeb}, ${appleApp}`,WAYPOINT_APPLE_TEAM_ID:'TEAM123456',WAYPOINT_APPLE_KEY_ID:'KEY1234567',WAYPOINT_APPLE_PRIVATE_KEY:p8,...overrides};
  const call=(path,options={},environment=env)=>worker.fetch(new Request('https://staging.test/WayPoint/api/'+path,options),environment,{});
  const post=(path,body,{cookie,environment}={})=>call(path,{method:'POST',body:JSON.stringify(body),headers:{
    'Content-Type':'application/json','CF-Connecting-IP':`address-${++nextAddress}`,...(cookie?{Cookie:cookie}:{})}},environment);
  const setup=await post('setup',{setupKey:'setup-secret',username:'testowner',password:'password123'});
  const owner={...await setup.json(),cookie:cookieFrom(setup)};
  const account=async username=>{
    const user=(await (await post('users',{username,password:'guest-password'},{cookie:owner.cookie})).json()).user;
    return {...user,cookie:cookieFrom(await post('login',{username,password:'guest-password'}))};
  };
  const guest=await account('guest');
  const users=()=>JSON.parse(kv.values.get('users')).users;
  const link=(accountId,provider='apple',sub='apple-guest')=>{
    const doc={users:users()};
    doc.users.find(u=>u.id===accountId).identities=[{provider,sub,linkedAt:'2026-01-01T00:00:00.000Z'}];
    kv.values.set('users',JSON.stringify(doc));
  };
  const exists=id=>users().some(u=>u.id===id);
  const signedIn=async cookie=>(await (await call('whoami',{headers:{Cookie:cookie}})).json()).loggedIn;
  const summary=async cookie=>(await call('account/deletion',{headers:{Cookie:cookie}})).json();
  const remove=(cookie,body={},options={})=>post('account/deletion',{confirm:'DELETE',...body},{cookie,...options});
  const store=who=>new SyncStore(db,{id:who.id,isUberUser:who.id===owner.id},secret);
  return {env,db,kv,call,post,owner,guest,account,users,link,exists,signedIn,summary,remove,store};
}
const mutation=(kind,tripId,recordId,data,operation='create',baseRevision=0)=>({mutationId:crypto.randomUUID(),tripId,kind,recordId,operation,baseRevision,data});
async function sharedTrip(s,{owner=s.owner,guest=s.guest,role='user'}={}) {
  const store=s.store(owner);
  await store.apply(mutation('trip','trip1','trip1',{name:'Shared trip',homeCurrency:'GBP'}));
  await store.apply(mutation('companion','trip1','person1',{name:'Guest name',notes:'Allergic to nuts'}));
  await setAccess(store,{tripId:'trip1',companionId:'person1',baseRevision:1,username:guest.username,role},{users:s.users()});
}
const count=async(s,sql)=>(await s.db.prepare(`SELECT count(*) AS n FROM ${sql}`).first()).n;
const companion=async s=>JSON.parse((await s.db.prepare("SELECT payload_json FROM records WHERE kind='companion' AND id='person1'").first()).payload_json);

test('deleting needs a live session',async t=>{
  const s=await site(t);
  assert.equal((await s.post('account/deletion',{confirm:'DELETE'})).status,401);
  assert.equal((await s.call('account/deletion')).status,401);
  assert.equal((await s.remove('wp_session=forged.token')).status,401);
  assert.ok(s.exists(s.guest.id));
});

test('only the exact confirmation deletes anything',async t=>{
  const s=await site(t);
  for(const confirm of [undefined,'','delete','yes',true])assert.equal((await s.post('account/deletion',{confirm},{cookie:s.guest.cookie})).status,400);
  assert.equal((await s.call('account/deletion',{method:'POST',body:'{not json',headers:{'Content-Type':'application/json',Cookie:s.guest.cookie}})).status,400);
  for(const code of ['',7,'x'.repeat(2049)])assert.equal((await s.remove(s.guest.cookie,{appleAuthorizationCode:code})).status,400);
  assert.ok(s.exists(s.guest.id));
  assert.equal(apple.calls.length,0);
});

test('deleting removes the account, ends its sessions and refuses it afterwards',async t=>{
  const s=await site(t);
  const other=cookieFrom(await s.post('login',{username:'guest',password:'guest-password'}));
  const response=await s.remove(s.guest.cookie);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'ok',appleRevoked:false});
  assert.match(response.headers.get('set-cookie'),/wp_session=;.*Max-Age=0/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(s.exists(s.guest.id),false);
  assert.equal(await s.signedIn(s.guest.cookie),false);
  assert.equal(await s.signedIn(other),false);
  assert.equal((await s.post('login',{username:'guest',password:'guest-password'})).status,401);
  assert.ok(await s.signedIn(s.owner.cookie));
});

test('a retry after a lost reply is told it worked',async t=>{
  const s=await site(t);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  const retry=await s.remove(s.guest.cookie);
  assert.equal(retry.status,200);
  assert.deepEqual(await retry.json(),{status:'ok',appleRevoked:false});
});

test('a session the owner has ended cannot delete the account',async t=>{
  const s=await site(t);
  await s.post('identities/reset',{accountId:s.guest.id},{cookie:s.owner.cookie});
  assert.equal((await s.remove(s.guest.cookie)).status,401);
  assert.ok(s.exists(s.guest.id));
});

test('the only site owner is refused, and is told so before confirming',async t=>{
  const s=await site(t);
  const summary=await s.summary(s.owner.cookie);
  assert.match(summary.blocked,/site owner/);
  const response=await s.remove(s.owner.cookie);
  assert.equal(response.status,409);
  assert.match((await response.json()).error,/site owner/);
  assert.ok(s.exists(s.owner.id));
});

test('a second site owner can leave, and the last one stays protected',async t=>{
  const s=await site(t);
  const doc={users:s.users()};doc.users.find(u=>u.id===s.guest.id).isUberUser=true;s.kv.values.set('users',JSON.stringify(doc));
  assert.equal((await s.summary(s.guest.cookie)).blocked,null);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal((await s.remove(s.owner.cookie)).status,409);
});

test('trips others shared lose this person, and every copy is told to refresh',async t=>{
  const s=await site(t);
  await sharedTrip(s);
  await s.db.prepare('INSERT INTO mutation_receipts VALUES(?,?,?,?,?)').bind(s.guest.id,'m1','hash','{}','2026-01-01').run();
  assert.equal((await s.summary(s.guest.cookie)).tripsLeft,1);
  const before=(await s.db.prepare('SELECT epoch FROM sync_state').first()).epoch;
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal(await count(s,'trip_grants'),0);
  assert.equal(await count(s,'mutation_receipts WHERE account_id='+JSON.stringify(s.guest.id).replace(/"/g,"'")),0);
  assert.equal((await companion(s)).accountId,undefined);
  assert.ok((await s.db.prepare('SELECT epoch FROM sync_state').first()).epoch>before);
  assert.equal(await count(s,"trips WHERE id='trip1' AND deleted=0"),1);
});

test('a sharing change during deletion stops it, and trying again works',async t=>{
  const s=await site(t);
  await sharedTrip(s);
  const third=await s.account('third');
  const original=s.db.batch.bind(s.db);
  s.db.batch=async list=>{
    if(list[0].sql.startsWith('INSERT INTO write_guards')&&list.length>3){
      s.db.batch=original;
      await s.store(s.owner).setGrant('trip1',{accountId:third.id,role:'admin'},s.users());
    }
    return original(list);
  };
  const response=await s.remove(s.guest.cookie);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,'concurrent_change');
  assert.ok(s.exists(s.guest.id));
  assert.equal(await count(s,'write_guards'),0);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
});

test('a storage failure leaves the account in place to try again',async t=>{
  const s=await site(t);
  await sharedTrip(s);
  const original=s.db.batch.bind(s.db);
  s.db.batch=async list=>{if(list[0].sql.startsWith('INSERT INTO write_guards')&&list.length>3){s.db.batch=original;s.db.failAfter=2;}return original(list);};
  assert.equal((await s.remove(s.guest.cookie)).status,503);
  assert.ok(s.exists(s.guest.id));
  assert.equal(await count(s,'trip_grants'),1);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal(await count(s,'trip_grants'),0);
});

test('if the account store fails after the trips, a retry finishes the job',async t=>{
  const s=await site(t);
  await sharedTrip(s);
  const put=s.kv.put.bind(s.kv);
  s.kv.put=async()=>{throw new Error('KV down');};
  assert.equal((await s.remove(s.guest.cookie)).status,503);
  s.kv.put=put;
  assert.ok(s.exists(s.guest.id));
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal(s.exists(s.guest.id),false);
});

test('an account edit made during deletion is not lost',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  apple.onRevoke=async()=>{await s.post('users',{username:'newcomer',password:'password123'},{cookie:s.owner.cookie});};
  assert.equal((await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'})).status,200);
  assert.ok(s.users().some(u=>u.username==='newcomer'));
  assert.equal(s.exists(s.guest.id),false);
});

test('the deletion route refuses when trips cannot be reached',async t=>{
  const s=await site(t);
  const env={WAYPOINT_KV:s.kv,WAYPOINT_SESSION_SECRET:secret};
  const call=options=>legacyWorker.fetch(new Request('https://example.test/WayPoint/api/account/deletion',{...options,headers:{Cookie:s.guest.cookie}}),env,{});
  assert.equal((await call({method:'POST',body:JSON.stringify({confirm:'DELETE'})})).status,503);
  assert.equal((await call({})).status,503);
  assert.ok(s.exists(s.guest.id));
});

test('while production is paused nothing is deleted',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  const hash='a'.repeat(64),stored=s.kv.values.get('users');
  const environment={...s.env,WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_SOURCE_HASH:hash,WAYPOINT_FREEZE_ID:'freeze',
    WAYPOINT_DB:{prepare:()=>({first:async()=>({source_hash:hash,state:'verified'})})}};
  const response=await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'},{environment});
  assert.equal(response.status,503);
  assert.equal((await response.json()).error.code,'migration_paused');
  assert.equal(s.kv.values.get('users'),stored);
  assert.equal(apple.calls.length,0);
});

test('Apple is revoked with a correctly signed secret, before anything is removed',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  let presentAtRevoke;
  apple.onRevoke=()=>{presentAtRevoke=s.exists(s.guest.id);};
  const response=await s.remove(s.guest.cookie,{appleAuthorizationCode:'fresh-code'});
  assert.deepEqual(await response.json(),{status:'ok',appleRevoked:true});
  assert.equal(presentAtRevoke,true);
  assert.equal(s.exists(s.guest.id),false);

  const [exchange,revoke]=apple.calls;
  assert.equal(apple.calls.length,2);
  assert.equal(exchange.form.get('grant_type'),'authorization_code');
  assert.equal(exchange.form.get('code'),'fresh-code');
  assert.equal(exchange.form.get('client_id'),appleApp);
  assert.equal(revoke.form.get('client_id'),appleApp);
  assert.equal(revoke.form.get('token'),'secret-refresh');
  assert.equal(revoke.form.get('token_type_hint'),'refresh_token');

  const clientSecret=exchange.form.get('client_secret');
  const [header,claims,signature]=clientSecret.split('.');
  assert.ok(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+claims)));
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',kid:'KEY1234567'});
  const body=JSON.parse(Buffer.from(claims,'base64url'));
  assert.equal(body.iss,'TEAM123456');
  assert.equal(body.sub,appleApp);
  assert.equal(body.aud,'https://appleid.apple.com');
  assert.ok(body.exp>body.iat&&body.exp-body.iat<=15777000);
});

test('a key pasted with escaped line breaks still works',async t=>{
  const s=await site(t,{WAYPOINT_APPLE_PRIVATE_KEY:p8.replace(/\n/g,'\\n')});
  s.link(s.guest.id);
  assert.deepEqual(await (await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'})).json(),{status:'ok',appleRevoked:true});
});

test('confirming with a different Apple ID deletes and revokes nothing',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  apple.sub='someone-else';
  const response=await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'});
  assert.equal(response.status,403);
  assert.match((await response.json()).error,/Apple ID/);
  assert.ok(s.exists(s.guest.id));
  assert.equal(apple.calls.filter(call=>call.url.endsWith('/auth/revoke')).length,0);
  assert.ok(await s.signedIn(s.guest.cookie));
});

for(const [name,arrange] of [
  ['the code is refused',()=>{apple.exchange=400;}],
  ['revocation is refused',()=>{apple.revoke=400;}],
  ['Apple cannot be reached',()=>{apple.down=true;}],
]){
  test(`the account is still deleted when ${name}`,async t=>{
    const s=await site(t);
    s.link(s.guest.id);
    arrange();
    const logged=[],log=console.error;console.error=line=>logged.push(String(line));t.after(()=>{console.error=log;});
    const response=await s.remove(s.guest.cookie,{appleAuthorizationCode:'secret-code'});
    assert.deepEqual(await response.json(),{status:'ok',appleRevoked:false});
    assert.equal(s.exists(s.guest.id),false);
    assert.equal(logged.length,1);
    assert.doesNotMatch(logged.join(),/secret|BEGIN|TEAM123456/);
  });
}

test('a malformed reply from Apple never stops a deletion',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  const real=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({access_token:'only'});
  t.after(()=>{globalThis.fetch=real;});
  const log=console.error;console.error=()=>{};t.after(()=>{console.error=log;});
  assert.deepEqual(await (await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'})).json(),{status:'ok',appleRevoked:false});
  assert.equal(s.exists(s.guest.id),false);
});

test('without the key, deletion works, Apple is not called, and the app is told',async t=>{
  for(const missing of ['WAYPOINT_APPLE_TEAM_ID','WAYPOINT_APPLE_KEY_ID','WAYPOINT_APPLE_PRIVATE_KEY']){
    const s=await site(t,{[missing]:undefined});
    s.link(s.guest.id);
    assert.equal((await s.summary(s.guest.cookie)).appleRevocation,false);
    assert.deepEqual(await (await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'})).json(),{status:'ok',appleRevoked:false});
  }
  const noAppID=await site(t,{WAYPOINT_APPLE_CLIENT_IDS:appleWeb});
  noAppID.link(noAppID.guest.id);
  assert.equal((await noAppID.summary(noAppID.guest.cookie)).appleRevocation,false);
  assert.equal(apple.calls.length,0);
});

test('deleting without a code still works for an Apple account',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  assert.deepEqual(await (await s.remove(s.guest.cookie)).json(),{status:'ok',appleRevoked:false});
  assert.equal(apple.calls.length,0);
});

test('a code sent for a Google or password account is ignored',async t=>{
  const s=await site(t);
  s.link(s.guest.id,'google','google-guest');
  assert.equal((await s.summary(s.guest.cookie)).linkedSignIn,'google');
  assert.deepEqual(await (await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'})).json(),{status:'ok',appleRevoked:false});
  assert.equal(apple.calls.length,0);
});

test('no Apple token is stored or returned, even when deletion stops halfway',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  const identity=s.users().find(u=>u.id===s.guest.id).identities[0];
  const original=s.db.batch.bind(s.db);
  s.db.batch=async list=>{if(list[0].sql.startsWith('INSERT INTO write_guards')){s.db.batch=original;s.db.failAfter=1;}return original(list);};
  const response=await s.remove(s.guest.cookie,{appleAuthorizationCode:'code'});
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/secret-/);
  assert.doesNotMatch(s.kv.values.get('users'),/secret-/);
  assert.deepEqual(Object.keys(s.users().find(u=>u.id===s.guest.id).identities[0]).sort(),Object.keys(identity).sort());
});

test('the summary says how this account signs in, and needs nothing from Apple',async t=>{
  const s=await site(t);
  s.link(s.guest.id);
  assert.deepEqual(await s.summary(s.guest.cookie),{linkedSignIn:'apple',appleRevocation:true,blocked:null,tripsErased:0,tripsHandedOver:0,tripsLeft:0});
  assert.equal(apple.calls.length,0);
});

// ---- The trip rule ---------------------------------------------------------
const url=new URL('https://staging.test/WayPoint/api/v1/sync/bootstrap?limit=100');
const visible=async(s,who)=>(await s.store(who).bootstrap(url)).entities.map(e=>`${e.kind}:${e.recordId}`).sort();
const tripRow=(s,id='trip1')=>s.db.prepare('SELECT * FROM trips WHERE id=?').bind(id).first();
const record=async(s,kind,id)=>{
  const row=await s.db.prepare('SELECT * FROM records WHERE kind=? AND id=?').bind(kind,id).first();
  return row&&{...row,data:JSON.parse(row.payload_json)};
};
async function ownTrip(s,who,id='trip1') {
  await s.store(who).apply(mutation('trip',id,id,{name:'Private plans',homeCurrency:'GBP',notes:'Surprise party'}));
  await s.store(who).apply(mutation('companion',id,`person-${id}`,{name:'Unlinked friend'}));
  await s.store(who).apply(mutation('activity',id,`activity-${id}`,{title:'Dinner',companions:[`person-${id}`,'__trip_superuser__']}));
}

test('a trip only they can open is erased, leaving an empty marker',async t=>{
  const s=await site(t);
  await ownTrip(s,s.guest);
  assert.deepEqual({...await s.summary(s.guest.cookie),linkedSignIn:null,appleRevocation:null},{linkedSignIn:null,appleRevocation:null,blocked:null,tripsErased:1,tripsHandedOver:0,tripsLeft:0});
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  const row=await tripRow(s);
  assert.deepEqual([row.deleted,row.owner_id,row.metadata_json,row.legacy_extras_json],[1,'','{}','{}']);
  assert.equal(await count(s,'records'),0);
  assert.equal(await count(s,'record_tags'),0);
  assert.doesNotMatch(JSON.stringify(row),new RegExp(s.guest.id));
});

test('an erased trip disappears for the site owner and its ID is never reused',async t=>{
  const s=await site(t);
  await ownTrip(s,s.guest);
  assert.ok((await visible(s,s.owner)).includes('trip:trip1'));
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.deepEqual(await visible(s,s.owner),[]);
  await assert.rejects(s.store(s.owner).apply(mutation('trip','trip1','trip1',{name:'Reused',homeCurrency:'GBP'})),e=>e.code==='deleted');
});

test('participants without accounts, and grants to deleted accounts, do not keep a trip',async t=>{
  const s=await site(t);
  await ownTrip(s,s.guest);
  const gone=await s.account('gone');
  await s.store(s.guest).setGrant('trip1',{accountId:gone.id,role:'viewer',companionId:'person-trip1'},s.users());
  await s.post('users/delete',{id:gone.id},{cookie:s.owner.cookie});
  assert.equal((await s.summary(s.guest.cookie)).tripsErased,1);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal((await tripRow(s)).deleted,1);
  assert.equal(await count(s,'trip_grants'),0);
});

test('a shared trip passes to an admin, who becomes its owner',async t=>{
  const s=await site(t);
  const admin=await s.account('admin');
  await sharedTrip(s,{owner:s.guest,guest:admin,role:'admin'});
  assert.equal((await s.summary(s.guest.cookie)).tripsHandedOver,1);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  const row=await tripRow(s);
  assert.deepEqual([row.deleted,row.owner_id],[0,admin.id]);
  assert.equal(await count(s,'trip_grants'),0);
  const trip=(await s.store(admin).bootstrap(url)).entities.find(e=>e.kind==='trip');
  assert.equal(trip.permission.role,'superuser');
  assert.equal(trip.data.name,'Shared trip');
});

test('the longest-standing admin inherits',async t=>{
  const s=await site(t);
  const later=await s.account('later'),earlier=await s.account('earlier');
  const doc={users:s.users()};
  doc.users.find(u=>u.id===later.id).createdAt='2026-06-01T00:00:00.000Z';
  doc.users.find(u=>u.id===earlier.id).createdAt='2026-01-01T00:00:00.000Z';
  s.kv.values.set('users',JSON.stringify(doc));
  await ownTrip(s,s.guest);
  await s.store(s.guest).setGrant('trip1',{accountId:later.id,role:'admin'},s.users());
  await s.store(s.guest).setGrant('trip1',{accountId:earlier.id,role:'admin'},s.users());
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal((await tripRow(s)).owner_id,earlier.id);
  assert.equal(await count(s,`trip_grants WHERE account_id='${later.id}' AND role='admin'`),1);
});

for(const role of ['user','viewer']){
  test(`with no admin, the site owner takes the trip and a ${role} sees nothing new`,async t=>{
    const s=await site(t);
    const member=await s.account('member');
    await sharedTrip(s,{owner:s.guest,guest:member,role});
    await s.store(s.guest).apply(mutation('activity','trip1','private',{title:'Not for them',companions:[]}));
    await s.store(s.guest).apply(mutation('activity','trip1','theirs',{title:'For them',companions:['person1']}));
    await s.store(s.guest).apply(mutation('expense','trip1','cost',{description:'Deposit',amount:10,currency:'GBP'}));
    const before=await visible(s,member);
    assert.ok(before.includes('activity:theirs'));
    assert.ok(!before.includes('activity:private'));
    assert.equal((await s.remove(s.guest.cookie)).status,200);
    assert.equal((await tripRow(s)).owner_id,s.owner.id);
    assert.deepEqual(await visible(s,member),before);
    const trip=(await s.store(member).bootstrap(url)).entities.find(e=>e.kind==='trip');
    assert.equal(trip.permission.role,role);
  });
}

test('the old owner\'s tag is removed, so the new owner is not put on their items',async t=>{
  const s=await site(t);
  const admin=await s.account('admin');
  await ownTrip(s,s.guest);
  await s.store(s.guest).setGrant('trip1',{accountId:admin.id,role:'admin'},s.users());
  await s.store(s.guest).apply(mutation('activity','trip1','solo',{title:'Their flight',companions:['__trip_superuser__']}));
  await s.store(s.guest).apply(mutation('activity','trip1','untagged',{title:'Lunch',companions:['person-trip1']}));
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  const both=await record(s,'activity','activity-trip1'),solo=await record(s,'activity','solo'),other=await record(s,'activity','untagged');
  assert.deepEqual(both.data.companions,['person-trip1']);
  assert.deepEqual(solo.data.companions,[]);
  assert.deepEqual([both.revision,solo.revision,other.revision],[2,2,1]);
  assert.equal(await count(s,"record_tags WHERE companion_id='__trip_superuser__'"),0);
  assert.equal(await count(s,"record_tags WHERE record_id='activity-trip1' AND companion_id='person-trip1'"),1);
});

test('on trips that stay, their participant entry becomes Former traveller',async t=>{
  const s=await site(t);
  await sharedTrip(s);
  const store=s.store(s.owner);
  await store.apply(mutation('companion','trip1','person2',{name:'Someone else',notes:'Keep this'}));
  await store.apply(mutation('activity','trip1','tagged',{title:'Museum',companions:['person1','person2']}));
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  const entry=await companion(s);
  assert.equal(entry.name,'Former traveller');
  assert.equal(entry.notes,'');
  assert.equal(entry.accountId,undefined);
  const other=await record(s,'companion','person2');
  assert.deepEqual([other.data.name,other.data.notes,other.revision],['Someone else','Keep this',1]);
  assert.deepEqual((await record(s,'activity','tagged')).data.companions,['person1','person2']);
  assert.doesNotMatch(JSON.stringify(await s.db.prepare('SELECT * FROM records').all()),/Guest name|Allergic/);
});

test('their own linked entry on a trip they hand over is replaced too',async t=>{
  const s=await site(t);
  const admin=await s.account('admin');
  await ownTrip(s,s.guest);
  await s.store(s.guest).setGrant('trip1',{accountId:admin.id,role:'admin'},s.users());
  await s.store(s.guest).apply(mutation('companion','trip1','me',{name:'Me myself'}));
  await s.db.prepare(`UPDATE records SET payload_json=json_set(payload_json,'$.accountId',?) WHERE id='me'`).bind(s.guest.id).run();
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal((await record(s,'companion','me')).data.name,'Former traveller');
});

test('other people\'s trips are left alone',async t=>{
  const s=await site(t);
  const third=await s.account('third');
  await ownTrip(s,third,'theirs');
  await ownTrip(s,s.guest,'mine');
  const before=await visible(s,third);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.deepEqual(await visible(s,third),before);
  assert.equal((await tripRow(s,'theirs')).owner_id,third.id);
});

test('the summary counts each kind of trip',async t=>{
  const s=await site(t);
  const member=await s.account('member');
  await ownTrip(s,s.guest,'solo1');await ownTrip(s,s.guest,'solo2');
  await ownTrip(s,s.guest,'shared');
  await s.store(s.guest).setGrant('shared',{accountId:member.id,role:'viewer',companionId:'person-shared'},s.users());
  await sharedTrip(s);
  const summary=await s.summary(s.guest.cookie);
  assert.deepEqual([summary.tripsErased,summary.tripsHandedOver,summary.tripsLeft],[2,1,1]);
});

test('a second site owner\'s shared trip passes to the remaining site owner',async t=>{
  const s=await site(t);
  const doc={users:s.users()};doc.users.find(u=>u.id===s.guest.id).isUberUser=true;s.kv.values.set('users',JSON.stringify(doc));
  const member=await s.account('member');
  await sharedTrip(s,{owner:s.guest,guest:member,role:'viewer'});
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal((await tripRow(s)).owner_id,s.owner.id);
});

test('a trip shared while deleting is not erased',async t=>{
  const s=await site(t);
  const late=await s.account('late');
  await ownTrip(s,s.guest);
  const original=s.db.batch.bind(s.db);
  s.db.batch=async list=>{
    if(list[0].sql.startsWith('INSERT INTO write_guards')&&list.length>3){
      s.db.batch=original;
      await s.store(s.guest).setGrant('trip1',{accountId:late.id,role:'viewer',companionId:'person-trip1'},s.users());
    }
    return original(list);
  };
  assert.equal((await s.remove(s.guest.cookie)).status,409);
  assert.equal((await tripRow(s)).deleted,0);
  assert.equal(await count(s,'records'),2);
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.equal((await tripRow(s)).owner_id,s.owner.id);
});

test('a failure partway erases nothing, and repeating a finished step changes nothing',async t=>{
  const s=await site(t);
  const admin=await s.account('admin');
  await ownTrip(s,s.guest,'solo');
  await ownTrip(s,s.guest,'shared');
  await s.store(s.guest).setGrant('shared',{accountId:admin.id,role:'admin'},s.users());
  const original=s.db.batch.bind(s.db);
  s.db.batch=async list=>{if(list[0].sql.startsWith('INSERT INTO write_guards')&&list.length>3){s.db.batch=original;s.db.failAfter=6;}return original(list);};
  assert.equal((await s.remove(s.guest.cookie)).status,503);
  assert.deepEqual([(await tripRow(s,'solo')).deleted,(await tripRow(s,'shared')).owner_id],[0,s.guest.id]);
  assert.equal(await count(s,'records'),4);

  const put=s.kv.put.bind(s.kv);
  s.kv.put=async()=>{throw new Error('KV down');};
  assert.equal((await s.remove(s.guest.cookie)).status,503);
  s.kv.put=put;
  const after=await s.db.prepare('SELECT id,owner_id,deleted,revision FROM trips ORDER BY id').all();
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  assert.deepEqual((await s.db.prepare('SELECT id,owner_id,deleted,revision FROM trips ORDER BY id').all()).results,after.results);
  assert.equal(s.exists(s.guest.id),false);
});

test('a device still holding the old copy is told to refresh, including after an erase',async t=>{
  const s=await site(t);
  await ownTrip(s,s.guest);
  const cursor=(await s.store(s.owner).bootstrap(url)).syncCursor;
  assert.equal((await s.remove(s.guest.cookie)).status,200);
  const changes=new URL('https://staging.test/WayPoint/api/v1/sync/changes?cursor='+encodeURIComponent(cursor));
  await assert.rejects(s.store(s.owner).changes(changes),e=>e.code==='bootstrap_required');
});
