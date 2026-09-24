import legacyWorker from '../worker.js';
import { APIError, fail, readJSON, mutation } from './protocol.js';
import { SyncStore } from './store.js';

const PREFIX='/WayPoint/api/v1';
const AUTH_PATHS=new Set(['/WayPoint/api/login','/WayPoint/api/logout','/WayPoint/api/whoami','/WayPoint/api/setup','/WayPoint/api/users','/WayPoint/api/users/delete']);
function json(value,status=200) {
  return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
export default {
  async fetch(request,env,ctx) {
    try {
      // This entrypoint deliberately cannot be used as the production cutover.
      if (env.WAYPOINT_ENV!=='staging' || !env.WAYPOINT_DB || !env.WAYPOINT_KV || !env.WAYPOINT_SESSION_SECRET) fail(503,'not_configured','The isolated staging backend is not configured.');
      const url=new URL(request.url);
      if (!['GET','POST'].includes(request.method)) return json({error:{code:'method_not_allowed',message:'Use GET or POST.'}},405);
      if (request.method==='POST') {
        const origin=request.headers.get('Origin');
        if (origin && origin!==url.origin) fail(403,'origin_rejected','Cross-origin writes are not allowed.');
        if (request.headers.get('Sec-Fetch-Site')==='cross-site') fail(403,'origin_rejected','Cross-site writes are not allowed.');
      }
      if (AUTH_PATHS.has(url.pathname)) {
        // Reuse proven auth using a SEPARATE staging KV and signing secret.
        // Size-bound before delegating; production code/route stays untouched.
        if (request.method==='POST') {
          const body=await readJSON(request,16384);
          request=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)});
        }
        const response=await legacyWorker.fetch(request,env,ctx);
        const headers=new Headers(response.headers); headers.set('Cache-Control','no-store');
        return new Response(response.body,{status:response.status,headers});
      }
      if (!url.pathname.startsWith(PREFIX+'/')) fail(404,'not_found','Endpoint unavailable. The old trip-data API is not enabled on staging.');
      const identity=await legacyWorker.fetch(new Request(url.origin+'/WayPoint/api/whoami',{headers:{Cookie:request.headers.get('Cookie')||''}}),env,ctx);
      if (identity.status!==200) fail(503,'auth_unavailable','Account service unavailable.');
      const user=await identity.json();
      if (!user.loggedIn) fail(401,'unauthorized','Sign in to continue.');
      const store=new SyncStore(env.WAYPOINT_DB,user,env.WAYPOINT_SESSION_SECRET);
      const path=url.pathname.slice(PREFIX.length);
      if (path==='/sync/capabilities' && request.method==='GET') return json({protocolVersion:1,environment:'staging',recordRevisions:true,maxMutationBatch:20,maxPageSize:100,productionReady:false,legacyTripRevisionsAccepted:false});
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
      return json({error:{code:'service_unavailable',message:'The staging service could not complete this request. Retry using the same mutation IDs.'}},503);
    }
  }
};
