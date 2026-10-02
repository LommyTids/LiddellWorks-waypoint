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
