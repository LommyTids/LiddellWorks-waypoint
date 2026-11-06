// The whole approval flow in a real browser, against the real Worker. Stand-ins
// replace Apple's and Google's scripts and mint tokens with a local key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import worker from '../../src/backend-v1/worker.js';
import { SQLiteD1,MemoryKV } from './sqlite-d1.mjs';

const origin='https://staging.test',app=origin+'/WayPoint/app';
const audiences={apple:'com.example.waypoint.web',google:'web.apps.googleusercontent.com'};
const issuers={apple:'https://appleid.apple.com',google:'https://accounts.google.com'};
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',hash:'SHA-256',modulusLength:2048,publicExponent:new Uint8Array([1,0,1])},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'browser-key',use:'sig',alg:'RS256'};
globalThis.fetch=async()=>Response.json({keys:[jwk]});

const encode=part=>Buffer.from(JSON.stringify(part)).toString('base64url');
async function mint(provider,sub,nonce) {
  const body=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:issuers[provider],aud:audiences[provider],sub,nonce,exp:Math.floor(Date.now()/1000)+600});
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(body));
  return body+'.'+Buffer.from(signature).toString('base64url');
}

const appleScript=`window.AppleID={auth:{init(config){this.config=config;},async signIn(){
  if(window.appleCancels)throw {error:'popup_closed_by_user'};
  return {authorization:{id_token:await mintToken('apple',window.appleSubject,this.config.nonce)}};}}};`;
const googleScript=`window.google={accounts:{id:{initialize(config){this.config=config;},renderButton(parent){
  parent.innerHTML='<button type="button" id="google-stand-in">Sign in with Google</button>';
  parent.firstChild.onclick=async()=>this.config.callback({credential:await mintToken('google',window.googleSubject,this.config.nonce)});}}}};`;

async function site(t,overrides={}) {
  const db=new SQLiteD1();t.after(()=>db.close());
  const env={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:new MemoryKV(),WAYPOINT_SESSION_SECRET:'browser-test-secret',WAYPOINT_PASSWORD:'browser-setup-key',
    WAYPOINT_APPLE_CLIENT_IDS:audiences.apple,WAYPOINT_GOOGLE_CLIENT_IDS:audiences.google,...overrides,
    ASSETS:{async fetch(request){
      const path=new URL(request.url).pathname;
      try{const content=await readFile(new URL('../../public'+path,import.meta.url));const type=path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':'application/octet-stream';return new Response(content,{headers:{'Content-Type':type}});}catch{return new Response('Not found',{status:404});}
    }}};
  const post=(path,body,cookie)=>worker.fetch(new Request(origin+'/WayPoint/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}),env,{});
  const setup=await post('setup',{setupKey:'browser-setup-key',username:'testowner',password:'password123'});
  await post('users',{username:'guest',password:'guest-password'},setup.headers.get('set-cookie').split(';')[0]);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const providerScripts=[],errors=[];
  async function visitor() {
    const context=await browser.newContext({viewport:{width:1100,height:800}});
    await context.exposeFunction('mintToken',mint);
    await context.route('**/*',async route=>{
      const r=route.request();
      if(r.url().startsWith('https://appleid.cdn-apple.com/')){providerScripts.push('apple');return route.fulfill({contentType:'text/javascript',body:appleScript});}
      if(r.url().startsWith('https://accounts.google.com/gsi/client')){providerScripts.push('google');return route.fulfill({contentType:'text/javascript',body:googleScript});}
      if(!r.url().startsWith(origin+'/'))return route.abort();
      const response=await worker.fetch(new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),...(r.postData()?{body:r.postData()}:{})}),env,{});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    return page;
  }
  return {env,visitor,providerScripts,errors};
}

async function signInAsOwner(page) {
  await page.goto(app+'#owner-login');
  await page.locator('#login-form [name="username"]').fill('testowner');
  await page.locator('#login-form [name="password"]').fill('password123');
  await page.getByRole('button',{name:'Log in',exact:true}).click();
  await page.waitForFunction(()=>currentUser&&currentUser.isUberUser);
  await page.evaluate(()=>loadAndRenderManageUsers());
  await page.getByRole('heading',{name:'Manage accounts'}).waitFor();
}
const accountRow=(page,name)=>page.locator('[data-item-section="account"]').filter({hasText:name});
async function createInvite(page,name) {
  await accountRow(page,name).getByRole('button',{name:'Invite'}).click();
  const link=await page.locator('.invite-link input').inputValue();
  await page.getByRole('button',{name:'Done'}).click();
  return link;
}
const signedInAs=(page,name)=>page.waitForFunction(expected=>currentUser&&currentUser.username===expected,name);

test('the owner approves someone by invite, then resets them',async t=>{
  const s=await site(t);
  const owner=await s.visitor();
  await signInAsOwner(owner);
  const guestRow=accountRow(owner,'guest');
  await guestRow.getByText('No sign-in linked').waitFor();
  const link=await createInvite(owner,'guest');
  assert.match(link,/^https:\/\/staging\.test\/WayPoint\/app#invite=[A-Za-z0-9_-]{43}$/);

  // Without an invite, a stranger gets no further than an explanation.
  const stranger=await s.visitor();
  await stranger.goto(app);
  await stranger.evaluate(()=>{window.appleSubject='stranger-apple';});
  await stranger.getByRole('button',{name:'Sign in with Apple'}).click();
  await stranger.getByText("This Apple account isn't linked to WayPoint yet.",{exact:false}).waitFor();
  assert.equal(await stranger.evaluate(()=>currentUser),null);

  // The invited person lands on the sign-in screen, and the token leaves the URL.
  const guest=await s.visitor();
  await guest.goto(link);
  await guest.getByText("You've been invited to Waypoint.").waitFor();
  assert.equal(new URL(guest.url()).hash,'');
  await guest.evaluate(()=>{window.appleSubject='guest-apple';});
  await guest.getByRole('button',{name:'Sign in with Apple'}).click();
  await signedInAs(guest,'guest');
  assert.equal(await guest.evaluate(()=>sessionStorage.getItem('waypoint-invite')),null);

  // Signing out and back in needs no invite.
  await guest.evaluate(()=>doLogout());
  await guest.getByRole('button',{name:'Sign in with Apple'}).waitFor();
  assert.equal(await guest.getByText("You've been invited to Waypoint.").count(),0);
  await guest.evaluate(()=>{window.appleSubject='guest-apple';});
  await guest.getByRole('button',{name:'Sign in with Apple'}).click();
  await signedInAs(guest,'guest');

  await owner.evaluate(()=>loadAndRenderManageUsers());
  await guestRow.getByText('Signs in with Apple').waitFor();
  assert.equal(await guestRow.getByRole('button',{name:'Invite'}).count(),0);

  await guestRow.getByRole('button',{name:'Reset sign-in'}).click();
  await owner.getByRole('button',{name:'Reset',exact:true}).click();
  await guestRow.getByText('No sign-in linked').waitFor();
  await guest.reload();
  await guest.getByRole('button',{name:'Sign in with Apple'}).waitFor();
  assert.equal(await guest.evaluate(()=>currentUser),null);

  // The reset also freed the account for a different provider.
  const replacement=await createInvite(owner,'guest');
  const google=await s.visitor();
  await google.goto(replacement);
  await google.evaluate(()=>{window.googleSubject='guest-google';});
  await google.locator('#google-stand-in').click();
  await signedInAs(google,'guest');
  assert.deepEqual(s.errors,[]);
});

test('a used invite is explained and then forgotten',async t=>{
  const s=await site(t);
  const owner=await s.visitor();
  await signInAsOwner(owner);
  const link=await createInvite(owner,'guest');
  await createInvite(owner,'guest');
  const page=await s.visitor();
  await page.goto(link);
  await page.evaluate(()=>{window.appleSubject='late-apple';});
  await page.getByRole('button',{name:'Sign in with Apple'}).click();
  await page.getByText('That invite has expired or has already been used.',{exact:false}).waitFor();
  assert.equal(await page.getByText("You've been invited to Waypoint.").count(),0);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('waypoint-invite')),null);
});

test('closing Apple\'s window leaves the screen as it was',async t=>{
  const s=await site(t);
  const page=await s.visitor();
  await page.goto(app);
  await page.evaluate(()=>{window.appleCancels=true;});
  await page.getByRole('button',{name:'Sign in with Apple'}).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.auth-error').count(),0);
  await page.getByRole('button',{name:'Sign in with Apple'}).waitFor();
});

test('an invite link opened in a tab already on the page still works',async t=>{
  const s=await site(t);
  const owner=await s.visitor();
  await signInAsOwner(owner);
  const link=await createInvite(owner,'guest');
  const page=await s.visitor();
  await page.goto(app);
  await page.getByRole('button',{name:'Sign in with Apple'}).waitFor();
  await page.goto(link);
  await page.getByText("You've been invited to Waypoint.").waitFor();
  assert.equal(new URL(page.url()).hash,'');
});

test('a failed provider script says so and leaves the phone form working',async t=>{
  const s=await site(t,{WAYPOINT_GOOGLE_CLIENT_IDS:undefined});
  const page=await s.visitor();
  await page.route('https://appleid.cdn-apple.com/**',route=>route.abort());
  await page.goto(app);
  await page.getByText('Sign-in options could not load.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sign in with Apple'}).isDisabled(),true);
  assert.equal(await page.locator('#login-form [name="phone"]').count(),1);
});

test('with phone login off, only the provider buttons remain',async t=>{
  const s=await site(t,{WAYPOINT_PHONE_LOGIN:'off'});
  const page=await s.visitor();
  await page.goto(app);
  await page.getByRole('button',{name:'Sign in with Apple'}).waitFor();
  assert.equal(await page.locator('#login-form').count(),0);
  assert.equal(await page.locator('.auth-divider').count(),0);
});

test('with no client IDs, nothing changes and no provider script loads',async t=>{
  const s=await site(t,{WAYPOINT_APPLE_CLIENT_IDS:undefined,WAYPOINT_GOOGLE_CLIENT_IDS:undefined});
  const page=await s.visitor();
  await page.goto(app);
  await page.locator('#login-form [name="phone"]').waitFor();
  assert.equal(await page.locator('.identity-sign-in').count(),0);
  const owner=await s.visitor();
  await signInAsOwner(owner);
  await accountRow(owner,'guest').waitFor();
  assert.equal(await owner.getByRole('button',{name:'Invite'}).count(),0);
  assert.equal(await owner.getByText('No sign-in linked').count(),0);
  assert.deepEqual(s.providerScripts,[]);
});
