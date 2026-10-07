import { initializeRehearsal,importPlan,verifyData,verifyPermissions,completeRehearsal } from '../../scripts/backend-v1/import-rehearsal.mjs';
import { buildImport } from '../../scripts/backend-v1/plan-import.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare runtime: cookie auth, D1 migrations, retries and competing writes',async t=>{
  const bundle=await build({entryPoints:['src/backend-v1/worker.js'],bundle:true,format:'esm',platform:'browser',write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-27',
    d1Databases:['WAYPOINT_DB','REHEARSAL_DB'],kvNamespaces:['WAYPOINT_KV'],bindings:{WAYPOINT_ENV:'staging',WAYPOINT_SESSION_SECRET:'runtime-test-secret',WAYPOINT_PASSWORD:'runtime-setup-key'}}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('WAYPOINT_DB');
  // The checked-in migration uses ordinary statements and BEGIN/END triggers.
  const sql=await readFile(new URL('../../migrations/backend-v1/0001_sync_foundation.sql',import.meta.url),'utf8');
  let statement='';const statements=[];
  for(const line of sql.split('\n')) {
    if (!line.trim() || line.trim().startsWith('--')) continue;
    statement+=line+'\n';
    if(statement.trim().startsWith('CREATE TRIGGER')?!/^END;$/.test(line.trim()):!line.trim().endsWith(';'))continue;
    statements.push(db.prepare(statement));statement='';
  }
  assert.equal(statement.trim(),'');await db.batch(statements);
  const call=(path,body,cookie)=>mf.dispatchFetch('https://staging.test/WayPoint/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const setup=await call('setup',{setupKey:'runtime-setup-key',username:'owner',password:'runtime-password'});
  assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];
  const mutation=(kind,recordId,operation,baseRevision,data)=>({mutationId:crypto.randomUUID(),tripId:'runtime-trip',kind,recordId,operation,baseRevision,data});
  const createTrip=mutation('trip','runtime-trip','create',0,{name:'Runtime trip'});
  let response=await call('v1/trips',createTrip,cookie);assert.equal(response.status,201,await response.text());
  const send=async changes=>{const r=await call('v1/sync/mutations',{protocolVersion:1,mutations:changes},cookie);const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body.results;};
  const create=mutation('activity','a1','create',0,{title:'Initial',companions:[]});
  assert.equal((await send([create]))[0].status,'applied');assert.equal((await send([create]))[0].duplicate,true);
  const outcomes=(await Promise.all(['A','B'].map(title=>send([mutation('activity','a1','update',1,{title})])))).flat();
  assert.equal(outcomes.filter(x=>x.status==='applied').length,1,JSON.stringify(outcomes));
  assert.equal(outcomes.filter(x=>x.status==='conflict').length,1);
  assert.equal((await db.prepare("SELECT revision FROM records WHERE id='a1'").first()).revision,2);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM changes WHERE kind='activity'").first()).n,2);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM write_guards').first()).n,0);
  const before=await (await call('v1/sync/bootstrap',null,cookie)).json();assert.equal(before.complete,true);
  const deletion=mutation('activity','a1','delete',2);delete deletion.data;
  assert.equal((await send([deletion]))[0].status,'applied');
  const delta=await (await call('v1/sync/changes?cursor='+encodeURIComponent(before.syncCursor),null,cookie)).json();
  assert.equal(delta.entities[0].operation,'delete');
  // A failed CHECK must roll back earlier statements in the SAME D1 batch.
  await assert.rejects(db.batch([db.prepare("UPDATE trips SET revision=99 WHERE id='runtime-trip'"),db.prepare("INSERT INTO write_guards VALUES('failure',0)")]));
  assert.equal((await db.prepare("SELECT revision FROM trips WHERE id='runtime-trip'").first()).revision,1);
  const rehearsalDB=await mf.getD1Database('REHEARSAL_DB');
  const source={format:'waypoint-kv-export-v1',entries:{users:JSON.stringify({users:[{id:'owner',username:'Owner'},{id:'viewer',username:'Viewer'}]}),trip_index:JSON.stringify({trips:[{tripId:'t1',ownerId:'owner',grants:[{accountId:'viewer',role:'viewer',companionId:'p1'}]}]}),'trip:t1':JSON.stringify({name:'Imported',companions:[{companionId:'p1',name:'Viewer',accountId:'viewer'}],activities:[{activityId:'a1',title:'Preserved',bookingRef:'private-ref',companions:['p1']}],expenses:[{expenseId:'e1',description:'Private',amount:'10'}]})}};
  const plan=buildImport(source);await initializeRehearsal(rehearsalDB);await importPlan(rehearsalDB,plan);
  assert.equal((await verifyData(rehearsalDB,source)).records,3);
  assert.equal((await verifyPermissions(rehearsalDB,source)).accountsChecked,2);
  await completeRehearsal(rehearsalDB,plan);await importPlan(rehearsalDB,plan);await verifyData(rehearsalDB,source);

});

test('Cloudflare runtime: production KV pause rejects existing-client write routes',async t=>{
  const bundle=await build({entryPoints:['src/worker.js'],bundle:true,format:'esm',platform:'browser',write:false});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-27',kvNamespaces:['WAYPOINT_KV'],bindings:{WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_FREEZE_ID:'runtime-freeze',WAYPOINT_SESSION_SECRET:'runtime-secret'}}));
  t.after(()=>mf.dispose());const kv=await mf.getKVNamespace('WAYPOINT_KV');await kv.put('trip_index','{"trips":[]}');
  for(const path of ['data','users','setup','trip-grants','companions/link','login']){
    const response=await mf.dispatchFetch('https://production.test/WayPoint/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,503,path);
  }
  const response=await mf.dispatchFetch('https://production.test/WayPoint/api/migration-status');assert.deepEqual(await response.json(),{storage:'kv',writesPaused:true,freezeId:'runtime-freeze'});
  assert.equal(await kv.get('trip_index'),'{"trips":[]}');assert.equal(await kv.get('users'),null);
});

test('Cloudflare runtime: production preview keeps credentials, reads imported D1 and rejects every save',async t=>{
 const {pbkdf2Sync}=await import('node:crypto');
 const bundle=await build({entryPoints:['src/router.js'],bundle:true,format:'esm',platform:'browser',write:false});
 const salt='00'.repeat(16),password='preview-password';
 const user={id:'owner',username:'owner',phone:'+447700900123',passwordSalt:salt,passwordHash:pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')};
 const source={format:'waypoint-kv-export-v1',entries:{users:JSON.stringify({users:[user]}),users_initialized:'1',trip_index:JSON.stringify({trips:[{tripId:'real-trip',ownerId:'owner',grants:[]}]}),'trip:real-trip':JSON.stringify({name:'Preserved trip',activities:[{activityId:'a1',title:'Preserved activity',companions:[]}]})}};
 const plan=buildImport(source);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-27',d1Databases:['WAYPOINT_DB'],kvNamespaces:['WAYPOINT_KV'],bindings:{WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_SOURCE_HASH:plan.sourceHash,WAYPOINT_FREEZE_ID:'preview-freeze',WAYPOINT_SESSION_SECRET:'existing-secret'}}));
 t.after(()=>mf.dispose());
 const db=await mf.getD1Database('WAYPOINT_DB'),kv=await mf.getKVNamespace('WAYPOINT_KV');
 await initializeRehearsal(db);await importPlan(db,plan);await completeRehearsal(db,plan);
 for(const [key,value] of Object.entries(source.entries))await kv.put(key,value);
 const call=(path,body,cookie)=>mf.dispatchFetch('https://production.test/WayPoint/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const login=await call('login',{username:'owner',password});assert.equal(login.status,200,await login.clone().text());const cookie=login.headers.get('set-cookie').split(';')[0];
 const caps=await (await call('v1/sync/capabilities',null,cookie)).json();assert.equal(caps.environment,'production');assert.equal(caps.writesPaused,true);assert.equal(caps.productionReady,false);
 const bootstrap=await (await call('v1/sync/bootstrap',null,cookie)).json();assert(bootstrap.entities.some(e=>e.data.title==='Preserved activity'));
 for(const path of ['data','v1/sync/mutations','v1/trips','v1/web/access','users','users/delete','setup','trip-grants','companions/link','account/avatar'])assert.equal((await call(path,{},cookie)).status,503,path);
 assert.equal((await call('logout',{},cookie)).status,200);
 assert.equal(await kv.get('users'),source.entries.users);await verifyData(db,source);
 const status=await (await call('migration-status')).json();assert.equal(status.storage,'d1');assert.equal(status.writesPaused,true);
 await db.prepare("UPDATE rehearsal_control SET state='active' WHERE id=1").run();
 assert.equal((await call('v1/sync/mutations',{},cookie)).status,503);
 assert.equal((await (await call('v1/sync/capabilities',null,cookie)).json()).productionReady,false);
});

test('Cloudflare runtime: unpause alone cannot activate, authorized editing writes only D1 trip data',async t=>{
 const {pbkdf2Sync}=await import('node:crypto');
 const bundle=await build({entryPoints:['src/router.js'],bundle:true,format:'esm',platform:'browser',write:false});
 const salt='00'.repeat(16),password='active-password';
 const user={id:'owner',username:'owner',phone:'+447700900123',passwordSalt:salt,passwordHash:pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')};
 const source={format:'waypoint-kv-export-v1',entries:{users:JSON.stringify({users:[user]}),users_initialized:'1',trip_index:JSON.stringify({trips:[{tripId:'real-trip',ownerId:'owner',grants:[]}]}),'trip:real-trip':JSON.stringify({name:'Preserved trip',activities:[{activityId:'a1',title:'Preserved activity',companions:[]}]})}};
 const plan=buildImport(source);
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-27',d1Databases:['WAYPOINT_DB'],kvNamespaces:['WAYPOINT_KV'],serviceBindings:{ASSETS:async request=>{let path=new URL(request.url).pathname;if(path==='/WayPoint/')path+='index.html';return new Response(await readFile(new URL('../../public'+path,import.meta.url)),{headers:{'Content-Type':path.endsWith('.html')?'text/html':'image/png'}});}},bindings:{WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'false',WAYPOINT_SOURCE_HASH:plan.sourceHash,WAYPOINT_FREEZE_ID:'active-freeze',WAYPOINT_SESSION_SECRET:'existing-secret'}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('WAYPOINT_DB'),kv=await mf.getKVNamespace('WAYPOINT_KV');
 await initializeRehearsal(db);await importPlan(db,plan);await completeRehearsal(db,plan);for(const [k,v] of Object.entries(source.entries))await kv.put(k,v);
 const call=(path,body,cookie)=>mf.dispatchFetch('https://production.test/WayPoint/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const blocked=await call('login',{username:'owner',password});assert.equal(blocked.status,503);assert.equal((await blocked.json()).error.code,'editing_not_authorized');
 await db.prepare("UPDATE rehearsal_control SET state='active' WHERE id=1").run();
 const login=await call('login',{phone:'+44 (7700) 900-123'});assert.equal(login.status,200);assert.equal((await login.clone().json()).id,'owner');const cookie=login.headers.get('set-cookie').split(';')[0];
 // Both address versions must access the same account and migrated trips.
 const lowerCall=(path,body,cookie)=>mf.dispatchFetch('https://production.test/waypoint/api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const lowerLogin=await lowerCall('login',{phone:'+447700900123'});assert.equal(lowerLogin.status,200);
 assert.match(lowerLogin.headers.get('set-cookie'),/Path=\/waypoint;/);
 assert.match(login.headers.get('set-cookie'),/Path=\/WayPoint;/);
 const lowerCookie=lowerLogin.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await lowerCall('whoami',null,lowerCookie)).json()).id,'owner');
 const html=await (await mf.dispatchFetch('https://production.test/waypoint/')).text();assert(html.includes('/waypoint/staging/d1-client.js'));assert(html.includes('/waypoint/branding/app-icon.png'));assert(!html.includes('/WayPoint/'));
 const markImage=await mf.dispatchFetch('https://production.test/waypoint/branding/waypoint-mark.png');assert.equal(markImage.status,200);assert.deepEqual(Buffer.from(await markImage.arrayBuffer()),await readFile('public/WayPoint/branding/waypoint-mark.png'));
 const caps=await (await call('v1/sync/capabilities',null,cookie)).json();assert.equal(caps.productionReady,true);assert.equal(caps.writesPaused,false);
 const mutation={mutationId:'active-edit-1',tripId:'real-trip',kind:'activity',recordId:'a1',operation:'update',baseRevision:1,data:{title:'Edited in production'}};
 const body={protocolVersion:1,mutations:[mutation]};
 const edit=await (await lowerCall('v1/sync/mutations',body,lowerCookie)).json();assert.equal(edit.results[0].status,'applied');
 const duplicate=await (await call('v1/sync/mutations',body,cookie)).json();assert.equal(duplicate.results[0].duplicate,true);
 const read=await (await call('v1/sync/bootstrap',null,cookie)).json();assert(read.entities.some(e=>e.data.title==='Edited in production'&&e.revision===2));
 assert.deepEqual(await (await lowerCall('v1/sync/bootstrap',null,lowerCookie)).json(),read);
 const logout=await lowerCall('logout',{},lowerCookie);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Path=\/waypoint;/);
 assert.equal((await call('data',{trips:[]},cookie)).status,404);assert.equal(await kv.get('trip_index'),source.entries.trip_index);assert.equal(await kv.get('trip:real-trip'),source.entries['trip:real-trip']);
 const conflict=await (await call('v1/sync/mutations',{protocolVersion:1,mutations:[{...mutation,mutationId:'active-conflict-2'}]},cookie)).json();assert.equal(conflict.results[0].status,'conflict');
});

test('canonical pages redirect, documents use lowercase URLs and images remain unchanged', async () => {
 const {default:router}=await import('../../src/router.js');
 const assets={async fetch(request){
  let path=new URL(request.url).pathname;
  if(path==='/WayPoint/')path+='index.html';
  const type=path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'image/png';
  return new Response(await readFile(new URL('../../public'+path,import.meta.url)),{headers:{'Content-Type':type,ETag:'old', 'Content-Length':'123'}});
 }};
 const env={ASSETS:assets};
 for(const path of ['/WayPoint','/WayPoint/','/WayPoint/app','/WayPoint/index.html','/waypoint','/waypoint/app','/waypoint/index.html']) {
  const response=await router.fetch(new Request('https://liddellworks.com'+path+'?from=old'),env,{});
  assert.equal(response.status,308);assert.equal(response.headers.get('Location'),'https://liddellworks.com/waypoint/?from=old');
 }
 for(const path of ['/waypoint/','/waypoint/js/auth.js','/waypoint/js/core.js','/waypoint/staging/d1-client.js','/waypoint/styles/base.css']) {
  const response=await router.fetch(new Request('https://liddellworks.com'+path),env,{});
  assert.equal(response.status,200);const body=await response.text();assert(!body.includes('/WayPoint/'),path);
  const sourcePath=path==='/waypoint/'?'/WayPoint/index.html':path.replace('/waypoint/','/WayPoint/');
  const original=await readFile(new URL('../../public'+sourcePath,import.meta.url),'utf8');
  assert.equal(body,original.replaceAll('/WayPoint','/waypoint'),path+' must rewrite only the canonical URL prefix');
  assert.equal(response.headers.get('ETag'),null);assert.equal(response.headers.get('Content-Length'),null);
 }
 for(const name of ['app-icon.png','waypoint-mark.png']) {
  const response=await router.fetch(new Request('https://liddellworks.com/waypoint/branding/'+name),env,{});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(new URL('../../public/WayPoint/branding/'+name,import.meta.url)));
 }
});
