#!/usr/bin/env node
import { readFile,writeFile,mkdtemp,rm,appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cloudflare,RemoteD1,check,RehearsalError } from './cloudflare.mjs';
import { exportSnapshot,verifySourceStable } from './source.mjs';
import { buildImport } from './plan-import.mjs';
import { LocalD1 } from './local-d1.mjs';
import { initializeRehearsal,importPlan,verifyData,verifyPermissions,completeRehearsal } from './import-rehearsal.mjs';

let phase='configuration',privateDir,databaseId,databaseName;
async function summary(report){
 const text=JSON.stringify(report,null,2);console.log(text);
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'## D1 migration rehearsal\n\n```json\n'+text+'\n```\n\nNo production switch was performed. A passing rehearsal is not a final migration backup.\n');
}
try{
 const config=JSON.parse(await readFile(new URL('../../config/backend-staging.json',import.meta.url),'utf8'));
 const production=await readFile(new URL('../../wrangler.toml',import.meta.url),'utf8');
 const kvBlocks=production.split('[[kv_namespaces]]').slice(1);
 const source=kvBlocks.find(block=>/binding\s*=\s*"WAYPOINT_KV"/.test(block))?.match(/\bid\s*=\s*"([a-f0-9]{32})"/i)?.[1];
 check(source&&source!==config.kvNamespaceId,'invalid_source_configuration');
 const local=process.argv[2]==='--local';check(process.argv.length===(local?4:2),'invalid_arguments');
 let snapshot,readApi,api;
 if(local){phase='read_private_export';snapshot=JSON.parse(await readFile(process.argv[3],'utf8'));}
 else{
   api=new Cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID||config.accountId,process.env.CLOUDFLARE_API_TOKEN);
   readApi=new Cloudflare(api.account,process.env.CLOUDFLARE_KV_READ_TOKEN||process.env.CLOUDFLARE_API_TOKEN);
   phase='read_only_source_export';snapshot=await exportSnapshot(readApi,source);
 }
 privateDir=await mkdtemp(join(process.env.RUNNER_TEMP||tmpdir(),'waypoint-rehearsal-'));
 await writeFile(join(privateDir,'source.private.json'),JSON.stringify(snapshot),{mode:0o600,flag:'wx'});
 phase='validate_source';const plan=buildImport(snapshot);
 phase='local_rehearsal';const localDB=new LocalD1();let counts,permissions;
 try{await initializeRehearsal(localDB);await importPlan(localDB,plan);counts=await verifyData(localDB,snapshot);permissions=await verifyPermissions(localDB,snapshot);await completeRehearsal(localDB,plan);}finally{localDB.close();}
 if(!local){
   phase='create_isolated_database';databaseName='waypoint-rehearsal-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomUUID().slice(0,8);
   // This entrypoint accepts NO destination ID and never reuses a named database.
   const created=await api.request('/d1/database',{method:'POST',body:{name:databaseName},retry:false});
   databaseId=created.result?.uuid;
   check(databaseId&&databaseId!==config.databaseId&&databaseId!==process.env.WAYPOINT_STAGING_D1_ID&&!production.includes(databaseId)&&created.result.name===databaseName,'destination_isolation_failed');
   console.log(JSON.stringify({status:'isolated_database_created',databaseName,databaseId}));
   const db=new RemoteD1(api,databaseId);
   phase='initialize_empty_database';await initializeRehearsal(db);
   phase='import_private_snapshot';
   for(let attempt=0;;attempt++){try{await importPlan(db,plan);break;}catch(e){if(e.code!=='import_interrupted'||attempt>=2)throw e;await new Promise(r=>setTimeout(r,1500));}}
   phase='compare_imported_data';counts=await verifyData(db,snapshot);
   phase='verify_account_visibility';permissions=await verifyPermissions(db,snapshot);
   phase='check_source_stability';await verifySourceStable(readApi,source,snapshot);
   phase='mark_verified';await completeRehearsal(db,plan);
 }
 await summary({status:'passed',mode:local?'local':'cloudflare',...(databaseId?{databaseName,databaseId}:{}),sourceHash:plan.sourceHash,counts,recordsByKind:plan.counts.byKind,permissions,sourceWrites:0,productionSwitch:false,accounts:'Credentials remain in existing KV; no account credentials imported into D1.',consistency:'Observed stable reads only. Final migration still requires paused writers and a retained private backup.'});
}catch(error){
 const code=error instanceof RehearsalError?error.code:'source_or_verification_error';
 // Do not print error.message/stack: errors can contain SQL, source IDs or data.
 await summary({status:'failed',phase,code,...(databaseName?{databaseName}:{}),...(databaseId?{databaseId}:{}),sourceWrites:0,productionSwitch:false});process.exitCode=1;
}finally{if(privateDir)await rm(privateDir,{recursive:true,force:true});}
