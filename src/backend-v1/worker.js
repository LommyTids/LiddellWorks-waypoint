import { presentation, setAccess } from './web.js';
import { ITEM_FIELDS } from '../worker.js';
import { KINDS, META_FIELDS } from './protocol.js';
import { setupResponse } from './setup-page.js';
import legacyWorker from '../worker.js';
import { APIError, fail, readJSON, mutation } from './protocol.js';
import { SyncStore } from './store.js';

const PREFIX='/WayPoint/api/v1';
const AUTH_PATHS=new Set(['/WayPoint/api/login','/WayPoint/api/logout','/WayPoint/api/whoami','/WayPoint/api/setup','/WayPoint/api/users','/WayPoint/api/users/delete','/WayPoint/api/account/avatar','/WayPoint/api/site-status','/WayPoint/api/flight-lookup','/WayPoint/api/location-search','/WayPoint/api/location-boundary','/WayPoint/api/location-boundaries']);
function json(value,status=200) {
  return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
export default {
  async fetch(request,env,ctx) {
    try {
      const production=env.WAYPOINT_ENV==='production';
      if (!['staging','production'].includes(env.WAYPOINT_ENV) || !env.WAYPOINT_DB || !env.WAYPOINT_KV || !env.WAYPOINT_SESSION_SECRET) fail(503,'not_configured','The sync backend is not configured.');
      // Production is read-only in this release. Removing a dashboard flag
      // cannot enable writes; activation requires a separate reviewed change.
      let authEnv=env;
      if(production){
        if(env.WAYPOINT_WRITES_PAUSED!=='true'||!env.WAYPOINT_SOURCE_HASH||!env.WAYPOINT_FREEZE_ID) fail(503,'production_not_paused','Production preview requires the migration pause.');
        const marker=await env.WAYPOINT_DB.prepare('SELECT source_hash FROM import_manifest WHERE id=1').first();
        const control=await env.WAYPOINT_DB.prepare('SELECT source_hash,state FROM rehearsal_control WHERE id=1').first();
        if(marker?.source_hash!==env.WAYPOINT_SOURCE_HASH||control?.source_hash!==env.WAYPOINT_SOURCE_HASH||control.state!=='verified') fail(503,'candidate_mismatch','The verified database is unavailable.');
        const denied=async()=>{const e=new Error('Writes paused');e.name='MigrationPausedError';throw e;};
        authEnv={...env,WAYPOINT_WRITES_PAUSED:'false',WAYPOINT_KV:{get:env.WAYPOINT_KV.get.bind(env.WAYPOINT_KV),put:denied,delete:denied}};
      }
      const url=new URL(request.url);
      if(production && url.pathname==='/WayPoint/api/migration-status' && request.method==='GET')return json({storage:'d1',writesPaused:true,freezeId:env.WAYPOINT_FREEZE_ID,sourceHash:env.WAYPOINT_SOURCE_HASH});
      if(production && request.method!=='GET' && !['/WayPoint/api/login','/WayPoint/api/logout'].includes(url.pathname))fail(503,'migration_paused','Saving is paused while the migrated trips are reviewed.');
      if (!['GET','POST'].includes(request.method)) return json({error:{code:'method_not_allowed',message:'Use GET or POST.'}},405);
      if (request.method==='POST') {
        const origin=request.headers.get('Origin');
        if (origin && origin!==url.origin) fail(403,'origin_rejected','Cross-origin writes are not allowed.');
        if (request.headers.get('Sec-Fetch-Site')==='cross-site') fail(403,'origin_rejected','Cross-site writes are not allowed.');
      }
      if(request.method==='GET' && url.pathname==='/WayPoint/d1-schema.js') return new Response('window.WAYPOINT_D1_SCHEMA='+JSON.stringify({kinds:KINDS,fields:ITEM_FIELDS,metadata:META_FIELDS})+';', {headers:{'Content-Type':'text/javascript','Cache-Control':'no-store'}});
      if(request.method==='GET' && (url.pathname==='/WayPoint/app'||(production&&['/WayPoint','/WayPoint/'].includes(url.pathname)))){
        if(!env.ASSETS)fail(503,'assets_missing','Redeploy with the web assets binding.');
        const asset=await env.ASSETS.fetch(new Request(url.origin+(production?'/WayPoint/':'/WayPoint/index.html')));
        if(!asset.ok)fail(503,'assets_missing','The web app assets could not be loaded.');
        const banner=production?'<body><div style="padding:10px;text-align:center;background:#fff3cd">Migration preview · Saving is paused</div>':'<body><div style="padding:10px;text-align:center;background:#e6f0ea;color:#17332f">Staging · Test trips only · <a href="/WayPoint/setup">Setup and tests</a></div>';
        const html=(await asset.text()).replace('<title>Waypoint</title>',production?'<title>Waypoint</title>':'<title>Waypoint · D1 staging</title>').replace('<body>', banner).replace('<script src="/WayPoint/js/boot.js"></script>','<script src="/WayPoint/d1-schema.js"></script><script src="/WayPoint/staging/d1-client.js"></script><script src="/WayPoint/js/boot.js"></script>');
        return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'}});
      }
      if(request.method==='GET' && /^\/WayPoint\/(js|styles|data|vendor|ui|staging)\//.test(url.pathname) && env.ASSETS) return env.ASSETS.fetch(request);
      if (!production && request.method==='GET' && ['/', '/WayPoint', '/WayPoint/', '/WayPoint/setup'].includes(url.pathname)) return setupResponse();
      if (!production && request.method==='GET' && url.pathname==='/WayPoint/staging.js') return setupResponse(true);
      if (AUTH_PATHS.has(url.pathname)) {
        // Keep credential verification in KV; production preview prevents KV writes.
        // Bound request size before delegating to the existing auth handlers.
        if (request.method==='POST' && url.pathname!=='/WayPoint/api/logout') {
          const body=await readJSON(request,16384);
          request=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)});
        }
        const response=await legacyWorker.fetch(request,authEnv,ctx);
        const headers=new Headers(response.headers); headers.set('Cache-Control','no-store');
        return new Response(response.body,{status:response.status,headers});
      }
      if (!url.pathname.startsWith(PREFIX+'/')) fail(404,'not_found','Endpoint unavailable. The old trip-data API is not enabled on D1.');
      const identity=await legacyWorker.fetch(new Request(url.origin+'/WayPoint/api/whoami',{headers:{Cookie:request.headers.get('Cookie')||''}}),authEnv,ctx);
      if (identity.status!==200) fail(503,'auth_unavailable','Account service unavailable.');
      const user=await identity.json();
      if (!user.loggedIn) fail(401,'unauthorized','Sign in to continue.');
      const store=new SyncStore(env.WAYPOINT_DB,user,env.WAYPOINT_SESSION_SECRET);
      const path=url.pathname.slice(PREFIX.length);
      if(path==='/web/presentation' && request.method==='GET') return json(await presentation(store,JSON.parse(await env.WAYPOINT_KV.get('users')||'{"users":[]}'),url.searchParams.get('cursor')));
      if(path==='/web/access' && request.method==='POST') return json(await setAccess(store,await readJSON(request,16384),JSON.parse(await env.WAYPOINT_KV.get('users')||'{"users":[]}')));
      if (path==='/sync/capabilities' && request.method==='GET') return json({protocolVersion:1,environment:env.WAYPOINT_ENV,writesPaused:production,recordRevisions:true,maxMutationBatch:20,maxPageSize:100,productionReady:false,legacyTripRevisionsAccepted:false});
      if (path==='/trips' && request.method==='GET') return json(await store.trips(url));
      if (path==='/trips' && request.method==='POST') {
        const body=await readJSON(request,65536);
        const input=mutation(body);
        if (input.kind!=='trip'||input.operation!=='create') fail(400,'invalid_mutation','Use a trip create mutation.');
        return json(await store.apply(input),201);
      }
      if (path==='/sync/bootstrap' && request.method==='GET') return json(await store.bootstrap(url));
      if (path==='/sync/changes' && request.method==='GET') return json(await store.changes(url));
      if (path==='/sync/mutations' && request.method==='POST') return json(await store.mutations(await readJSON(request)));
      const grant=/^\/trips\/([A-Za-z0-9_-]+)\/grants$/.exec(path);
      if (grant && request.method==='POST') {
        const accounts=JSON.parse(await env.WAYPOINT_KV.get('users')||'{"users":[]}').users;
        return json(await store.setGrant(grant[1],await readJSON(request,16384),accounts));
      }
      fail(404,'not_found','Endpoint unavailable.');
    } catch(error) {
      if (error instanceof APIError) return json({error:{code:error.code,message:error.message}},error.status);
      // Never log account data, payloads, cookies, SQL parameters or credentials.
      console.error('waypoint-v1 request failed');
      return json({error:{code:'service_unavailable',message:'The sync service could not complete this request. Retry using the same mutation IDs.'}},503);
    }
  }
};
