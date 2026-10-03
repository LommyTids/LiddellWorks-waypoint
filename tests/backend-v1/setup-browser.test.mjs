import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import worker from '../../src/backend-v1/worker.js';
import { SQLiteD1,MemoryKV } from './sqlite-d1.mjs';

test('tablet setup, rejected key, dummy sync checks, cleanup and subsequent sign-in',async t=>{
 const db=new SQLiteD1();t.after(()=>db.close());
 const env={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:new MemoryKV(),WAYPOINT_SESSION_SECRET:'test-signing-key',WAYPOINT_PASSWORD:'test-setup-key'};
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:820,height:1180}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://staging.test/**',async route=>{
  const r=route.request();const response=await worker.fetch(new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),...(r.postData()?{body:r.postData()}: {})}),env,{});
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await page.goto('https://staging.test/');
 await page.getByRole('heading',{name:'Create your staging account'}).waitFor();
 await page.getByLabel('Setup key',{exact:true}).fill('wrong');await page.getByLabel('Username',{exact:true}).fill('tester');await page.getByLabel('Login password',{exact:true}).fill('test-password');
 await page.getByRole('button',{name:'Create staging account',exact:true}).click();
 await page.getByText('Incorrect setup key.',{exact:true}).waitFor();assert.equal(await page.locator('#setup-key').inputValue(),'');
 await page.getByLabel('Setup key',{exact:true}).fill('test-setup-key');await page.getByLabel('Login password',{exact:true}).fill('test-password');await page.getByRole('button',{name:'Create staging account',exact:true}).click();
 await page.getByRole('button',{name:'Run dummy-trip tests'}).click();
 await page.getByText('All tests passed. Send this result back to continue the migration preparation.',{exact:true}).waitFor();
 assert.equal(await page.locator('#results li').count(),6);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM trips WHERE deleted=0').first()).n,0);
 assert.equal(await page.locator('#password').inputValue(),'');
 assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('heading',{name:'Sign in to staging'}).waitFor();
 await page.getByLabel('Login password',{exact:true}).fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByText('Your staging account is ready.',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 const prod=await worker.fetch(new Request('https://staging.test/'),{...env,WAYPOINT_ENV:'production'},{});assert.equal(prod.status,503);
});

test('tablet web app creates a trip and activity through D1 and reloads saved data',async t=>{
 const {readFile}=await import('node:fs/promises');
 const db=new SQLiteD1();t.after(()=>db.close());
 const env={WAYPOINT_ENV:'staging',WAYPOINT_DB:db,WAYPOINT_KV:new MemoryKV(),WAYPOINT_SESSION_SECRET:'web-test-signing-key',WAYPOINT_PASSWORD:'web-test-setup-key',ASSETS:{async fetch(request){
  const path=new URL(request.url).pathname;
  try{const content=await readFile(new URL('../../public'+path,import.meta.url));const type=path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':path.endsWith('.svg')?'image/svg+xml':'application/octet-stream';return new Response(content,{headers:{'Content-Type':type}});}catch{return new Response('Not found',{status:404});}
 }}};
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const ctx=await browser.newContext({viewport:{width:820,height:1180}});const page=await ctx.newPage();const errors=[],paths=[];page.on('pageerror',e=>errors.push(e.message));
 await ctx.route('**/*',async route=>{
  const r=route.request();if(!r.url().startsWith('https://staging.test/'))return route.abort();paths.push(new URL(r.url()).pathname);
  const response=await worker.fetch(new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),...(r.postData()?{body:r.postData()}: {})}),env,{});
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
 await page.goto('https://staging.test/');await page.getByRole('heading',{name:'Create your staging account'}).waitFor();
 await page.getByLabel('Setup key',{exact:true}).fill('web-test-setup-key');await page.getByLabel('Username',{exact:true}).fill('webtester');await page.getByLabel('Login password',{exact:true}).fill('web-test-password');await page.getByRole('button',{name:'Create staging account',exact:true}).click();await page.getByText('Your staging account is ready.',{exact:true}).waitFor();
 await page.getByRole('link',{name:'Open staging app'}).click();
 await page.locator('[data-action="new-trip"]').first().click();await page.locator('#entity-form [name="name"]').fill('D1 browser trip');await page.getByRole('button',{name:'Create trip',exact:true}).click();
 await page.waitForFunction(()=>!saveInFlight&&stateIsTrustworthy&&state.trips.length===1&&state.trips[0].name==='D1 browser trip');
 // Open the real activity editor; its form and save use the unmodified web UI.
 await page.evaluate(()=>openActivityForm(state.trips[0]));
 await page.locator('#entity-form [name="title"]').fill('Museum from browser');
 await page.locator('#entity-form [name="startDate"]').fill('2026-09-25');
 await page.locator('#entity-form [name="endDate"]').fill('2026-09-25');
 await page.locator('#entity-form button[type="submit"]').click();
 await page.waitForFunction(()=>!saveInFlight&&stateIsTrustworthy&&state.trips[0]?.activities.some(a=>a.title==='Museum from browser'));
 await page.reload();await page.waitForFunction(()=>stateIsTrustworthy&&state.trips[0]?.activities.some(a=>a.title==='Museum from browser'));
 assert.equal(paths.includes('/WayPoint/api/data'),false);assert(paths.includes('/WayPoint/api/v1/sync/mutations'));assert.deepEqual(errors,[]);
 assert.equal(env.WAYPOINT_KV.values.has('trip_index'),false);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM trips WHERE deleted=0').first()).n,1);
 await page.evaluate(()=>doLogout());await page.waitForFunction(()=>currentUser===null);assert.equal(await page.evaluate(()=>state.trips.length),0);
});

test('production browser signs in to imported trips, shows pause and blocks edits without changing data',async t=>{
 const {readFile}=await import('node:fs/promises');
 const {pbkdf2Sync}=await import('node:crypto');
 const {LocalD1}=await import('../../scripts/backend-v1/local-d1.mjs');
 const {buildImport}=await import('../../scripts/backend-v1/plan-import.mjs');
 const {initializeRehearsal,importPlan,completeRehearsal,verifyData}=await import('../../scripts/backend-v1/import-rehearsal.mjs');
 const salt='00'.repeat(16),password='browser-preview-password';
 const user={id:'owner',username:'owner',passwordSalt:salt,passwordHash:pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')};
 const source={format:'waypoint-kv-export-v1',entries:{users:JSON.stringify({users:[user]}),users_initialized:'1',trip_index:JSON.stringify({trips:[{tripId:'real-trip',ownerId:'owner',grants:[]}]}),'trip:real-trip':JSON.stringify({name:'Real imported trip',activities:[{activityId:'a1',title:'Preserved activity',companions:[]}]})}};
 const plan=buildImport(source),db=new LocalD1();t.after(()=>db.close());
 await initializeRehearsal(db);await importPlan(db,plan);await completeRehearsal(db,plan);
 const env={WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_SOURCE_HASH:plan.sourceHash,WAYPOINT_FREEZE_ID:'browser-freeze',WAYPOINT_SESSION_SECRET:'existing-secret',WAYPOINT_DB:db,WAYPOINT_KV:new MemoryKV(source.entries),ASSETS:{async fetch(request){
  let path=new URL(request.url).pathname;if(path==='/WayPoint/')path+="index.html";
  try{const content=await readFile(new URL('../../public'+path,import.meta.url));return new Response(content,{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
 }}};
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext();const page=await context.newPage(),errors=[],paths=[];page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  const r=route.request();if(!r.url().startsWith('https://production.test/'))return route.abort();paths.push(new URL(r.url()).pathname);
  const response=await worker.fetch(new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),...(r.postData()?{body:r.postData()}: {})}),env,{});
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
 await page.goto('https://production.test/WayPoint/');
 await page.locator('#login-form [name="username"]').fill('owner');await page.locator('#login-form [name="password"]').fill(password);await page.getByRole('button',{name:'Log in',exact:true}).click();
 await page.waitForFunction(()=>stateIsTrustworthy&&state.trips[0]?.activities.some(a=>a.title==='Preserved activity'));
 await page.getByText('Migration preview · Saving is paused',{exact:true}).waitFor();
 const rejected=await page.evaluate(async()=>{const r=await fetch('/WayPoint/api/v1/sync/mutations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return r.status;});assert.equal(rejected,503);
 await page.reload();await page.waitForFunction(()=>stateIsTrustworthy&&state.trips[0]?.name==='Real imported trip');
 assert(!paths.includes('/WayPoint/api/data'));assert.deepEqual(errors,[]);assert.equal(await env.WAYPOINT_KV.get('users'),source.entries.users);await verifyData(db,source);
 await db.prepare("UPDATE rehearsal_control SET state='active' WHERE id=1").run();env.WAYPOINT_WRITES_PAUSED='false';
 await page.reload();await page.waitForFunction(()=>stateIsTrustworthy&&state.trips.length===1);
 assert.equal(await page.getByText('Migration preview · Saving is paused',{exact:true}).count(),0);
 await page.evaluate(()=>openActivityForm(state.trips[0],state.trips[0].activities[0]));
 await page.locator('#entity-form [name="title"]').fill('Edited production activity');
 await page.locator('#entity-form [name="startDate"]').fill('2026-10-03');await page.locator('#entity-form [name="endDate"]').fill('2026-10-03');
 await page.locator('#entity-form button[type="submit"]').click();
 await page.waitForFunction(()=>!saveInFlight&&stateIsTrustworthy&&state.trips[0]?.activities.some(a=>a.title==='Edited production activity'));
 await page.reload();await page.waitForFunction(()=>stateIsTrustworthy&&state.trips[0]?.activities.some(a=>a.title==='Edited production activity'));
 assert.equal(await env.WAYPOINT_KV.get('trip:real-trip'),source.entries['trip:real-trip']);assert(!paths.includes('/WayPoint/api/data'));assert.deepEqual(errors,[]);
});
