#!/usr/bin/env node
import {readFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Cloudflare,RemoteD1,check,RehearsalError} from './cloudflare.mjs';
import {verifyPreview} from './production-preview.mjs';

export async function assertD1Paused(pins,fetcher=fetch){
 let response;
 try{response=await fetcher('https://liddellworks.com/WayPoint/api/migration-status?check='+crypto.randomUUID(),{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(30000)});}catch{throw new RehearsalError('preview_status_network_error');}
 check(response.ok,'preview_status_http_'+response.status);
 let status;try{status=await response.json();}catch{throw new RehearsalError('preview_status_invalid_response');}
 check(status?.storage==='d1'&&status.writesPaused===true&&status.freezeId===pins.freezeId&&status.sourceHash===pins.sourceHash,'preview_not_paused');
 check(status.activationSupported===true,'activation_code_not_deployed');
 return status;
}
export async function authorizeEditing({api,readApi,pins,fetcher}){
 // Independent reconstruction also rejects reruns after any real D1 edit.
 const checkPause=()=>assertD1Paused(pins,fetcher);
 const report=await verifyPreview({api,readApi,pins,checkPause,allowAuthorized:true});
 await checkPause();
 const db=new RemoteD1(api,pins.databaseId);
 await db.prepare("UPDATE rehearsal_control SET state='active' WHERE id=1 AND source_hash=? AND state IN ('verified','active')").bind(pins.sourceHash).run();
 const control=await db.prepare('SELECT source_hash,state FROM rehearsal_control WHERE id=1').first();
 check(control?.source_hash===pins.sourceHash&&control.state==='active','editing_authorization_unverified');
 const status=await checkPause();
 check(status.editingAuthorized===true,'live_authorization_unverified');
 return {...report,status:'editing_authorized',productionSwitch:false,writesPaused:true,sourceWrites:0,destinationWrites:'Activation marker only; no trip changes',nextStep:'Set WAYPOINT_WRITES_PAUSED to false on waypoint-app and deploy. Verify live D1 status before editing. Never resume legacy KV trip writers.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let report;
 try{
  check(process.env.EDITING_CONFIRMATION==='AUTHORIZE D1 EDITING','confirmation_required');
  check(process.env.REAL_TRIPS_REVIEWED==='true','trip_review_required');
  check(process.env.OTHER_WRITERS_PAUSED==='true','other_writers_not_paused');
  check(process.env.GITHUB_REF==='refs/heads/main','main_required');
  const pins=JSON.parse(await readFile(new URL('../../config/backend-production.json',import.meta.url),'utf8'));
  const api=new Cloudflare(pins.accountId,process.env.CLOUDFLARE_API_TOKEN);
  const sourceApi=new Cloudflare(pins.accountId,process.env.CLOUDFLARE_KV_READ_TOKEN||process.env.CLOUDFLARE_API_TOKEN);
  const readApi={request:(path,options)=>path.includes('/namespaces/'+pins.kvNamespaceId+'/')?sourceApi.request(path,options):api.request(path,options)};
  report=await authorizeEditing({api,readApi,pins});
 }catch(error){report={status:'failed',code:error instanceof RehearsalError?error.code:'editing_authorization_failed',nextStep:'Keep the pause. The marker may have been written; no automatic unpause or rollback was attempted.'};process.exitCode=1;}
 console.log(JSON.stringify(report));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'## D1 editing authorization\n\n```json\n'+JSON.stringify(report,null,2)+'\n```\n');
}
