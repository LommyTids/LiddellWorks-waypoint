#!/usr/bin/env node
import { readFile,writeFile,mkdir,appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cloudflare,RemoteD1,check,RehearsalError } from './cloudflare.mjs';
import { exportSnapshot,verifySourceStable } from './source.mjs';
import { buildImport,SourceValidationError } from './plan-import.mjs';
import { LocalD1 } from './local-d1.mjs';
import { initializeRehearsal,importPlan,verifyData,verifyPermissions,completeRehearsal } from './import-rehearsal.mjs';
import { encryptBackup,retainBackup } from './migration-backup.mjs';
import { assertPaused,assertDistinctResources,settlePausedSource } from './migration-control.mjs';

export async function prepareProduction(options){
 const {api,readApi,source,staging,freezeId,expectedHash,publicKey,onReport=()=>{},backupOutput}=options;
 let phase='configuration',databaseId,databaseName,backupNamespaceId,backup;
 const setPhase=async value=>{phase=value;await onReport({status:'progress',phase});};
 const metadata=()=>({...(backupNamespaceId?{backupNamespaceId}:{}),...(backup?{backup}:{}),...(databaseId?{databaseId,databaseName}:{}),sourceWrites:0,productionSwitch:false});
 try{
  check(/^[a-f0-9]{64}$/.test(expectedHash||''),'invalid_expected_hash');
  // Validate the key before the operator spends time waiting on the pause.
  encryptBackup({format:'waypoint-kv-export-v1',entries:{}},publicKey);
  check(source!==staging.kvNamespaceId,'source_is_staging');
  await setPhase('verify_write_pause');await settlePausedSource(freezeId,options.wait,options.fetcher);
  await setPhase('frozen_source_export');const snapshot=await exportSnapshot(readApi,source);await assertPaused(freezeId,options.fetcher);
  await setPhase('validate_source');const plan=buildImport(snapshot);check(plan.sourceHash===expectedHash,'source_hash_changed');
  await setPhase('local_verification');const local=new LocalD1();
  try{await initializeRehearsal(local);await importPlan(local,plan);await verifyData(local,snapshot);await verifyPermissions(local,snapshot);await completeRehearsal(local,plan);}finally{local.close();}
  await assertPaused(freezeId,options.fetcher);await verifySourceStable(readApi,source,snapshot);
  await setPhase('retain_encrypted_backup');
  const envelope=encryptBackup(snapshot,publicKey),backupId=new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomUUID();
  const title='waypoint-migration-backup-'+backupId;
  const createdBackup=await api.request('/storage/kv/namespaces',{method:'POST',body:{title},retry:false});
  backupNamespaceId=createdBackup.result?.id;
  assertDistinctResources(source,staging,backupNamespaceId);check(createdBackup.result.title===title,'backup_isolation_failed');
  backup=await retainBackup(api,backupNamespaceId,envelope,backupId);
  if(backupOutput)await writeFile(backupOutput,JSON.stringify(envelope)+'\n',{mode:0o600,flag:'wx'});
  await onReport({status:'backup_retained_and_readback_verified',...metadata()});
  await assertPaused(freezeId,options.fetcher);await verifySourceStable(readApi,source,snapshot);
  await setPhase('create_production_candidate');
  databaseName='waypoint-production-candidate-'+backupId;
  const created=await api.request('/d1/database',{method:'POST',body:{name:databaseName},retry:false});databaseId=created.result?.uuid;
  check(/^[a-f0-9-]{36}$/i.test(databaseId||'')&&created.result.name===databaseName,'destination_isolation_failed');
  assertDistinctResources(source,staging,backupNamespaceId,databaseId);
  const db=new RemoteD1(api,databaseId);await initializeRehearsal(db);
  await setPhase('import_frozen_snapshot');
  for(let attempt=0;;attempt++){try{await importPlan(db,plan);break;}catch(e){if(e.code!=='import_interrupted'||attempt>=2)throw e;await (options.wait||((ms)=>new Promise(r=>setTimeout(r,ms))))(1500);}}
  await setPhase('reconcile_and_check_permissions');const counts=await verifyData(db,snapshot),permissions=await verifyPermissions(db,snapshot);
  await setPhase('verify_source_still_frozen');await assertPaused(freezeId,options.fetcher);await verifySourceStable(readApi,source,snapshot);
  await completeRehearsal(db,plan);
  const report={status:'prepared',phase:'awaiting_cutover_review',...metadata(),sourceHash:plan.sourceHash,counts,recordsByKind:plan.counts.byKind,permissions,freezeId,liveStorage:'kv',writesPaused:true,backupRecovery:'Download and decrypt the retained backup with your private key before cutover approval.',nextStep:'Keep writers paused for cutover review, or resume KV edits and discard this candidate for migration purposes. No deployment or routing change was made.'};
  await onReport(report);return report;
 }catch(error){
  const report={status:'failed',phase,code:error instanceof RehearsalError||error instanceof SourceValidationError?error.code:'preparation_failed',...(error instanceof SourceValidationError?{location:error.location}:{}),...metadata(),nextStep:'The workflow never releases the write pause automatically. Review the failure; resume KV only if abandoning this migration attempt.'};
  await onReport(report);throw new RehearsalError(report.code);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let finalReport;
 try{
  check(process.argv.length===2,'invalid_arguments');
  check(process.env.MIGRATION_CONFIRMATION==='PREPARE FROZEN MIGRATION','confirmation_required');
  check(process.env.OTHER_WRITERS_PAUSED==='true','other_writers_not_paused');
  const staging=JSON.parse(await readFile(new URL('../../config/backend-staging.json',import.meta.url),'utf8'));
  const production=await readFile(new URL('../../wrangler.toml',import.meta.url),'utf8');
  check(/name\s*=\s*"waypoint-app"/.test(production)&&/main\s*=\s*"src\/worker.js"/.test(production),'unsupported_production_configuration');
  const source=production.split('[[kv_namespaces]]').slice(1).find(b=>/binding\s*=\s*"WAYPOINT_KV"/.test(b))?.match(/\bid\s*=\s*"([a-f0-9]{32})"/i)?.[1];check(source,'invalid_source_configuration');
  const api=new Cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID||staging.accountId,process.env.CLOUDFLARE_API_TOKEN);
  const readApi=new Cloudflare(api.account,process.env.CLOUDFLARE_KV_READ_TOKEN||process.env.CLOUDFLARE_API_TOKEN);
  const outputDir=process.env.WAYPOINT_BACKUP_OUTPUT_DIR;check(outputDir,'missing_backup_output');await mkdir(outputDir,{recursive:true,mode:0o700});
  await prepareProduction({api,readApi,source,staging,freezeId:process.env.WAYPOINT_FREEZE_ID,expectedHash:process.env.EXPECTED_SOURCE_HASH,publicKey:process.env.WAYPOINT_BACKUP_PUBLIC_KEY,backupOutput:join(outputDir,'source.encrypted.json'),onReport:async report=>{console.log(JSON.stringify(report));if(report.status==='prepared'||report.status==='failed'){finalReport=report;await writeFile(join(outputDir,'migration-summary.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}}});
 }catch(error){if(!finalReport){finalReport={status:'failed',phase:'configuration',code:error instanceof RehearsalError?error.code:'configuration_failed',sourceWrites:0,productionSwitch:false};console.log(JSON.stringify(finalReport));}process.exitCode=1;
 }finally{
  if(finalReport&&process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'## Final migration preparation\n\n```json\n'+JSON.stringify(finalReport,null,2)+'\n```\n\nLive storage remains KV. The write pause is controlled by the operator; this workflow never deploys or resumes writes.\n');
 }
}
