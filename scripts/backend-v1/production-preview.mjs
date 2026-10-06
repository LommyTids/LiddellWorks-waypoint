#!/usr/bin/env node
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Cloudflare,RemoteD1,check,RehearsalError} from './cloudflare.mjs';
import {assertPaused} from './migration-control.mjs';
import {exportSnapshot,verifySourceStable} from './source.mjs';
import {buildImport} from './plan-import.mjs';
import {verifyData,verifyPermissions} from './import-rehearsal.mjs';
import {readRetainedBackup} from './migration-backup.mjs';

export async function verifyPreview({api,readApi,pins,fetcher,checkPause,allowAuthorized=false}){
 check(api.account===pins.accountId,'account_mismatch');
 await (checkPause?checkPause():assertPaused(pins.freezeId,fetcher));
 const snapshot=await exportSnapshot(readApi,pins.kvNamespaceId);
 check(buildImport(snapshot).sourceHash===pins.sourceHash,'source_hash_changed');
 const manifestKey='migration:'+pins.backupId+':manifest';
 const manifest=JSON.parse(await readApi.request('/storage/kv/namespaces/'+pins.backupNamespaceId+'/values/'+encodeURIComponent(manifestKey),{raw:true}));
 check(manifest.sourceHash===pins.sourceHash&&manifest.backupId===pins.backupId&&manifest.encryptedSha256===pins.encryptedSha256&&manifest.keyFingerprint===pins.keyFingerprint,'backup_identity_mismatch');
 await readRetainedBackup(readApi,pins.backupNamespaceId,manifest);
 const destination=await api.request('/d1/database/'+pins.databaseId);
 check(destination.result?.uuid===pins.databaseId&&destination.result.name===pins.databaseName,'database_identity_mismatch');
 const db=new RemoteD1(api,pins.databaseId);
 const marker=await db.prepare('SELECT source_hash FROM import_manifest WHERE id=1').first();
 const control=await db.prepare('SELECT source_hash,state FROM rehearsal_control WHERE id=1').first();
 check(marker?.source_hash===pins.sourceHash&&control?.source_hash===pins.sourceHash&&(control.state==='verified'||(allowAuthorized&&control.state==='active')),'candidate_not_verified');
 const counts=await verifyData(db,snapshot),permissions=await verifyPermissions(db,snapshot);
 await verifySourceStable(readApi,pins.kvNamespaceId,snapshot);
 await (checkPause?checkPause():assertPaused(pins.freezeId,fetcher));
 return {status:'preview_preflight_passed',databaseId:pins.databaseId,sourceHash:pins.sourceHash,counts,permissions,sourceWrites:0,destinationWrites:0,productionSwitch:false};
}
export function previewConfiguration(pins){
 return {name:'waypoint-app',account_id:pins.accountId,main:'src/router.js',compatibility_date:'2026-08-27',keep_vars:true,
 routes:[{pattern:'liddellworks.com/waypoint*',zone_name:'liddellworks.com'},{pattern:'liddellworks.com/WayPoint*',zone_name:'liddellworks.com'}],
 assets:{directory:'./public',binding:'ASSETS',run_worker_first:true,html_handling:'auto-trailing-slash'},
 vars:{WAYPOINT_ENV:'production',WAYPOINT_WRITES_PAUSED:'true',WAYPOINT_FREEZE_ID:pins.freezeId,WAYPOINT_SOURCE_HASH:pins.sourceHash},
 kv_namespaces:[{binding:'WAYPOINT_KV',id:pins.kvNamespaceId}],
 d1_databases:[{binding:'WAYPOINT_DB',database_name:pins.databaseName,database_id:pins.databaseId}]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let report;
 try{
  check(process.env.PREVIEW_CONFIRMATION==='DEPLOY READ ONLY D1','confirmation_required');
  check(process.env.BACKUP_RECOVERY_VERIFIED==='true','backup_recovery_ack_required');
  check(process.env.OTHER_WRITERS_PAUSED==='true','other_writers_not_paused');
  check(process.env.GITHUB_REF==='refs/heads/main','main_required');
  const pins=JSON.parse(await readFile(new URL('../../config/backend-production.json',import.meta.url),'utf8'));
  const api=new Cloudflare(pins.accountId,process.env.CLOUDFLARE_API_TOKEN);
  // The source-only token may not read the retained backup namespace.
  const sourceApi=new Cloudflare(pins.accountId,process.env.CLOUDFLARE_KV_READ_TOKEN||process.env.CLOUDFLARE_API_TOKEN);
  const readApi={request:(path,options)=>path.includes('/namespaces/'+pins.kvNamespaceId+'/')?sourceApi.request(path,options):api.request(path,options)};
  report=await verifyPreview({api,readApi,pins});
  await writeFile(new URL('../../wrangler.production-preview.generated.json',import.meta.url),JSON.stringify(previewConfiguration(pins),null,2)+'\n');
 }catch(error){report={status:'failed',code:error instanceof RehearsalError?error.code:'preview_verification_failed',productionSwitch:false,sourceWrites:0};process.exitCode=1;}
 console.log(JSON.stringify(report));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'## Read-only D1 preview preflight\n\n```json\n'+JSON.stringify(report,null,2)+'\n```\n\nPreflight does not deploy. See the deployment step separately. Saving remains paused.\n');
}
