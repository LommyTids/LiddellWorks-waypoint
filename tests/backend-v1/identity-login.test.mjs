// Sign in with Apple and Google, using locally made RSA keys in place of the
// providers' published ones. No test here reaches a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../../src/backend-v1/worker.js';
import { SQLiteD1,MemoryKV } from './sqlite-d1.mjs';

const secret='test-only-long-session-secret';
const appleWeb='com.example.waypoint.web',appleApp='com.example.waypoint',googleWeb='web.apps.googleusercontent.com';
const issuers={apple:'https://appleid.apple.com',google:'https://accounts.google.com'};
const audiences={apple:appleWeb,google:googleWeb};
const minute=60000,day=86400000;

async function signingKey(kid) {
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',hash:'SHA-256',modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},true,['sign','verify']);
  return {kid,privateKey:pair.privateKey,jwk:{...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,use:'sig',alg:'RS256'}};
}
const keys={apple:await signingKey('apple-1'),google:await signingKey('google-1')};
const forger=await signingKey('apple-1');

const published={apple:[keys.apple.jwk],google:[keys.google.jwk]};
const provider={keysDown:false,requests:0};
globalThis.fetch=async url=>{
  provider.requests++;
  if(provider.keysDown)return new Response('unavailable',{status:503});
  const name=String(url).includes('appleid.apple.com')?'apple':String(url).includes('googleapis.com')?'google':null;
  if(!name)throw new Error('Unexpected request: '+url);
  return Response.json({keys:published[name]});
};

const encode=part=>Buffer.from(JSON.stringify(part)).toString('base64url');
async function idToken(key,claims) {
  const body=encode({alg:'RS256',kid:key.kid,typ:'JWT'})+'.'+encode(claims);
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(body));
  return body+'.'+Buffer.from(signature).toString('base64url');
}
const cookieFrom=response=>response.headers.get('set-cookie')?.split(';')[0]??null;
function clock(t) {
  const real=Date.now,base=real();t.after(()=>{Date.now=real;});
  return offset=>{Date.now=()=>base+offset;};
}

let nextAddress=0;
async function site(t,overrides={}) {
  const db=new SQLiteD1();t.after(()=>db.close());
  const kv=new MemoryKV();
  const env={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:kv,WAYPOINT_PASSWORD:'setup-secret',WAYPOINT_SESSION_SECRET:secret,
    WAYPOINT_APPLE_CLIENT_IDS:`${appleWeb}, ${appleApp}`,WAYPOINT_GOOGLE_CLIENT_IDS:googleWeb,...overrides};
  const call=(path,options={},environment=env)=>worker.fetch(new Request('https://staging.test/WayPoint/api/'+path,options),environment,{});
  const post=(path,body,{cookie,address,environment}={})=>call(path,{method:'POST',body:JSON.stringify(body),headers:{
    'Content-Type':'application/json','CF-Connecting-IP':address??`address-${++nextAddress}`,...(cookie?{Cookie:cookie}:{})}},environment);
  const setup=await post('setup',{setupKey:'setup-secret',username:'testowner',password:'password123'});
  const owner={...await setup.json(),cookie:cookieFrom(setup)};
  const created=await post('users',{username:'guest',password:'guest-password'},{cookie:owner.cookie});
  const guest=(await created.json()).user;
  const whoami=async cookie=>(await call('whoami',{headers:{Cookie:cookie}})).json();
  const nonce=async environment=>(await (await call('login/nonce',{},environment)).json()).nonce;
  const invite=async(accountId=guest.id)=>(await (await post('invites',{accountId},{cookie:owner.cookie})).json()).invite;
  async function signIn(name,sub,{claims={},key=keys[name],invite,address,environment}={}) {
    const issued=await nonce(environment);
    const token=await idToken(key,{iss:issuers[name],aud:audiences[name],sub,nonce:issued,exp:Math.floor(Date.now()/1000)+600,email:'private@example.com',...claims});
    return post('login/identity',{provider:name,idToken:token,...(invite?{invite}:{})},{address,environment});
  }
  return {env,kv,call,post,owner,guest,whoami,nonce,invite,signIn};
}

test('nothing is active until client IDs are configured',async t=>{
  const s=await site(t,{WAYPOINT_APPLE_CLIENT_IDS:undefined,WAYPOINT_GOOGLE_CLIENT_IDS:undefined});
  assert.deepEqual(await (await s.call('login/config')).json(),{providers:{},phoneLogin:true});
  assert.equal((await s.signIn('apple','apple-user')).status,404);
  assert.equal((await s.post('invites',{accountId:s.guest.id},{cookie:s.owner.cookie})).status,409);
  assert.equal(provider.requests,0);
});

test('config offers each configured provider its website and app client IDs',async t=>{
  const s=await site(t,{WAYPOINT_GOOGLE_CLIENT_IDS:''});
  const response=await s.call('login/config');
  assert.deepEqual(await response.json(),{providers:{apple:{clientId:appleWeb,nativeClientId:appleApp}},phoneLogin:true});
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await s.signIn('google','google-user')).status,404);
  const webOnly=await site(t,{WAYPOINT_APPLE_CLIENT_IDS:appleWeb});
  assert.equal((await (await webOnly.call('login/config')).json()).providers.apple.nativeClientId,null);
});

test('an invite links an identity once, and the identity then signs in by itself',async t=>{
  const s=await site(t);
  const stranger=await s.signIn('apple','apple-user');
  assert.equal(stranger.status,403);assert.equal(cookieFrom(stranger),null);

  const invite=await s.invite();
  const linked=await s.signIn('apple','apple-user',{invite});
  assert.equal(linked.status,200);
  assert.deepEqual(Object.keys(await linked.clone().json()).sort(),['avatar','id','isUberUser','status','username']);
  const session=await s.whoami(cookieFrom(linked));
  assert.equal(session.id,s.guest.id);assert.equal(session.isUberUser,false);

  const returning=await s.signIn('apple','apple-user');
  assert.equal((await returning.json()).id,s.guest.id);
  const reused=await s.signIn('apple','someone-else',{invite});
  assert.equal(reused.status,403);assert.equal(cookieFrom(reused),null);
});

test('Google accepts both issuer spellings, and native client IDs are accepted',async t=>{
  const s=await site(t);
  assert.equal((await s.signIn('google','google-user',{invite:await s.invite(),claims:{iss:'accounts.google.com'}})).status,200);
  assert.equal((await s.signIn('google','google-user',{claims:{iss:'https://accounts.google.com'}})).status,200);
  const ownerLink=await s.signIn('apple','owner-apple',{invite:await s.invite(s.owner.id),claims:{aud:appleApp}});
  assert.equal(ownerLink.status,200);assert.equal((await ownerLink.json()).isUberUser,true);
});

test('the same subject from another provider is a different person',async t=>{
  const s=await site(t);
  await s.signIn('apple','shared-subject',{invite:await s.invite()});
  assert.equal((await s.signIn('google','shared-subject')).status,403);
});

test('tokens that fail any single check do not sign in a linked identity',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  assert.equal((await s.signIn('apple','apple-user')).status,200);
  const cases={
    'another audience':{claims:{aud:'com.example.other'}},
    'audience list':{claims:{aud:[appleWeb]}},
    'another issuer':{claims:{iss:issuers.google}},
    'expired':{claims:{exp:Math.floor(Date.now()/1000)-1}},
    'missing expiry':{claims:{exp:undefined}},
    'another nonce':{claims:{nonce:'another-nonce'}},
    'missing nonce':{claims:{nonce:undefined}},
    'forged signature':{key:forger},
  };
  for(const [name,options] of Object.entries(cases)){
    const response=await s.signIn('apple','apple-user',options);
    assert.equal(response.status,401,name);assert.equal(cookieFrom(response),null,name);
  }
});

test('tokens cannot choose their own algorithm',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  const nonce=await s.nonce();
  const claims={iss:issuers.apple,aud:appleWeb,sub:'apple-user',nonce,exp:Math.floor(Date.now()/1000)+600};
  const unsigned=encode({alg:'none',kid:'apple-1'})+'.'+encode(claims)+'.';
  const body=encode({alg:'HS256',kid:'apple-1'})+'.'+encode(claims);
  const publicKeyAsSecret=body+'.'+createHmac('sha256',JSON.stringify(keys.apple.jwk)).update(body).digest('base64url');
  for(const idToken of [unsigned,publicKeyAsSecret,'not-a-token','a.b.c'])
    assert.equal((await s.post('login/identity',{provider:'apple',idToken})).status,401);
});

test('nonces must be issued here and still be current',async t=>{
  const s=await site(t),time=clock(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  const send=idToken=>s.post('login/identity',{provider:'apple',idToken});
  const claims=nonce=>({iss:issuers.apple,aud:appleWeb,sub:'apple-user',nonce,exp:Math.floor(Date.now()/1000)+3600});

  const made='zzzzzzzz.chosen-by-a-client.'+'A'.repeat(43);
  assert.equal((await send(await idToken(keys.apple,claims(made)))).status,401);
  const session=s.owner.cookie.split('=')[1];
  assert.equal((await send(await idToken(keys.apple,claims(session)))).status,401);

  const issued=await s.nonce(),token=await idToken(keys.apple,claims(issued));
  time(9*minute);assert.equal((await send(token)).status,200);
  time(11*minute);assert.equal((await send(token)).status,401);
});

test('invites expire, and a new invite withdraws the last one',async t=>{
  const s=await site(t),time=clock(t);
  const first=await s.invite(),second=await s.invite();
  assert.equal((await s.signIn('apple','apple-user',{invite:first})).status,403);
  time(8*day);
  assert.equal((await s.signIn('apple','apple-user',{invite:second})).status,403);
});

test('a refused invite says so, and an unlinked identity is told to ask for one',async t=>{
  const s=await site(t);
  assert.match((await (await s.signIn('apple','apple-user',{invite:'not-a-real-invite'})).json()).error,/expired or has already been used/);
  assert.match((await (await s.signIn('apple','apple-user')).json()).error,/isn't linked to WayPoint yet/);
});

test('the owner can see which accounts have a linked sign-in',async t=>{
  const s=await site(t);
  await s.signIn('google','google-user',{invite:await s.invite()});
  const {users}=await (await s.call('users',{headers:{Cookie:s.owner.cookie}})).json();
  assert.equal(users.find(u=>u.id===s.guest.id).linkedSignIn,'google');
  assert.equal(users.find(u=>u.id===s.owner.id).linkedSignIn,null);
});

test('pages hide their origin from other sites until Google sign-in needs it',async t=>{
  const ASSETS={fetch:async()=>new Response('<title>Waypoint</title><body>')};
  const policy=async overrides=>{
    const s=await site(t,{ASSETS,...overrides});
    return (await worker.fetch(new Request('https://staging.test/WayPoint/app'),s.env,{})).headers.get('referrer-policy');
  };
  assert.equal(await policy({WAYPOINT_GOOGLE_CLIENT_IDS:undefined}),'no-referrer');
  assert.equal(await policy({}),'strict-origin-when-cross-origin');
});

test('only the owner can create invites, and only for real accounts',async t=>{
  const s=await site(t);
  const guest=cookieFrom(await s.post('login',{username:'guest',password:'guest-password'}));
  assert.equal((await s.post('invites',{accountId:s.guest.id},{cookie:guest})).status,403);
  assert.equal((await s.post('invites',{accountId:s.guest.id})).status,401);
  assert.equal((await s.post('invites',{accountId:'u_missing'},{cookie:s.owner.cookie})).status,404);
});

test('a linked identity cannot quietly move to another account',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  const moved=await s.signIn('apple','apple-user',{invite:await s.invite(s.owner.id)});
  assert.equal(moved.status,409);assert.equal(cookieFrom(moved),null);
});

test('an invite cannot add a second sign-in to an account that has one',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  assert.equal((await s.signIn('google','google-user',{invite:await s.invite()})).status,409);
});

test('an owner reset lets a new identity replace the old one',async t=>{
  const s=await site(t);
  const session=cookieFrom(await s.signIn('apple','old-apple',{invite:await s.invite()}));
  const password=cookieFrom(await s.post('login',{username:'guest',password:'guest-password'}));
  const unused=await s.invite();
  const reset=await s.post('identities/reset',{accountId:s.guest.id},{cookie:s.owner.cookie});
  assert.equal(reset.status,200);
  assert.deepEqual(await reset.json(),{status:'ok',accountId:s.guest.id});

  assert.equal((await s.whoami(session)).loggedIn,false);
  assert.equal((await s.whoami(password)).loggedIn,false);
  assert.equal((await s.signIn('apple','old-apple')).status,403);
  assert.equal((await s.signIn('google','new-google',{invite:unused})).status,403);

  const relinked=await s.signIn('google','new-google',{invite:await s.invite()});
  assert.equal(relinked.status,200);
  assert.equal((await relinked.json()).id,s.guest.id);
  assert.equal((await s.signIn('google','new-google')).status,200);
});

test('only the owner can reset a sign-in, and only for real accounts',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  const guest=cookieFrom(await s.post('login',{username:'guest',password:'guest-password'}));
  assert.equal((await s.post('identities/reset',{accountId:s.guest.id},{cookie:guest})).status,403);
  assert.equal((await s.post('identities/reset',{accountId:s.guest.id})).status,401);
  assert.equal((await s.post('identities/reset',{accountId:'u_missing'},{cookie:s.owner.cookie})).status,404);
  assert.equal((await s.signIn('apple','apple-user')).status,200);
});

test('deleting an account removes its sign-in',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  assert.equal((await s.post('users/delete',{id:s.guest.id},{cookie:s.owner.cookie})).status,200);
  assert.equal((await s.signIn('apple','apple-user')).status,403);
});

test('provider details and invites stay out of responses and storage',async t=>{
  const s=await site(t);
  const invite=await s.invite();
  assert(!s.kv.values.get('users').includes(invite));
  await s.signIn('apple','apple-user',{invite});
  const stored=s.kv.values.get('users');
  assert(stored.includes('apple-user'));assert(!stored.includes('private@example.com'));
  const list=await (await s.call('users',{headers:{Cookie:s.owner.cookie}})).text();
  for(const hidden of ['apple-user','identities','invite','passwordHash'])assert(!list.includes(hidden),hidden);
});

test('repeated failures are limited per address',async t=>{
  const s=await site(t),address='limited-address';
  for(let attempt=0;attempt<8;attempt++)assert.equal((await s.signIn('apple','apple-user',{address})).status,403);
  assert.equal((await s.signIn('apple','apple-user',{address})).status,429);
});

test('rotated keys load on demand, and unknown key IDs cannot force a fetch each time',async t=>{
  const s=await site(t),time=clock(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  time(40*day);
  assert.equal((await s.signIn('apple','apple-user')).status,200);
  const rotated=await signingKey('apple-2');published.apple.push(rotated.jwk);t.after(()=>published.apple.pop());
  const before=provider.requests;
  for(let attempt=0;attempt<3;attempt++)assert.equal((await s.signIn('apple','apple-user',{key:rotated})).status,401);
  assert.equal(provider.requests,before);
  time(40*day+2*minute);
  assert.equal((await s.signIn('apple','apple-user',{key:rotated})).status,200);
  assert.equal(provider.requests,before+1);
});

test('a provider key outage refuses sign-in without touching the account',async t=>{
  const s=await site(t),time=clock(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  const stored=s.kv.values.get('users');
  provider.keysDown=true;t.after(()=>{provider.keysDown=false;});
  time(50*day);
  assert.equal((await s.signIn('apple','apple-user')).status,503);
  assert.equal(s.kv.values.get('users'),stored);
});

test('phone login can be switched off without affecting passwords',async t=>{
  const s=await site(t,{WAYPOINT_PHONE_LOGIN:'off'});
  const accounts=JSON.parse(s.kv.values.get('users'));
  accounts.users.find(u=>u.id===s.guest.id).phone='+447700900123';
  s.kv.values.set('users',JSON.stringify(accounts));
  assert.equal((await (await s.call('login/config')).json()).phoneLogin,false);
  const phone=await s.post('login',{phone:'+447700900123'});
  assert.equal(phone.status,403);assert.equal(cookieFrom(phone),null);
  assert.equal((await s.post('login',{username:'guest',password:'guest-password'})).status,200);
});

test('ending all sessions keeps only the owner who asked',async t=>{
  const s=await site(t);
  const guest=cookieFrom(await s.post('login',{username:'guest',password:'guest-password'}));
  assert.equal((await s.post('sessions/end-all',{},{cookie:guest})).status,403);
  const ended=await s.post('sessions/end-all',{},{cookie:s.owner.cookie});
  assert.equal(ended.status,200);
  assert.equal((await s.whoami(guest)).loggedIn,false);
  assert.equal((await s.whoami(s.owner.cookie)).loggedIn,false);
  assert.equal((await s.whoami(cookieFrom(ended))).id,s.owner.id);
});

test('while production is paused, linked identities sign in and invites wait',async t=>{
  const s=await site(t);
  await s.signIn('apple','apple-user',{invite:await s.invite()});
  const pending=await s.invite(s.owner.id);
  const hash='a'.repeat(64),stored=s.kv.values.get('users');
  const environment={...s.env,WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_SOURCE_HASH:hash,WAYPOINT_FREEZE_ID:'freeze',
    WAYPOINT_DB:{prepare:()=>({first:async()=>({source_hash:hash,state:'verified'})})}};
  assert.equal((await s.signIn('apple','apple-user',{environment})).status,200);
  assert.equal((await s.signIn('google','owner-google',{invite:pending,environment})).status,503);
  assert.equal((await s.post('invites',{accountId:s.guest.id},{cookie:s.owner.cookie,environment})).status,503);
  assert.equal((await s.post('identities/reset',{accountId:s.guest.id},{cookie:s.owner.cookie,environment})).status,503);
  assert.equal(s.kv.values.get('users'),stored);
});
