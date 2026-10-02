import { check,RehearsalError } from './cloudflare.mjs';
export const SOURCE_STATUS='https://liddellworks.com/WayPoint/api/migration-status';
export async function assertPaused(freezeId,fetcher=fetch){
 check(/^[A-Za-z0-9_-]{8,128}$/.test(freezeId||''),'invalid_freeze_id');
 let response,status;
 try{response=await fetcher(SOURCE_STATUS+'?check='+crypto.randomUUID(),{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});status=await response.json();}catch{throw new RehearsalError('source_pause_unavailable');}
 check(response.ok&&status.storage==='kv'&&status.writesPaused===true&&status.freezeId===freezeId,'source_not_paused');
}
export function assertDistinctResources(source,staging,backup,destination){
 check(/^[a-f0-9]{32}$/i.test(source)&&/^[a-f0-9]{32}$/i.test(backup),'invalid_namespace');
 check(source.toLowerCase()!==backup.toLowerCase()&&staging.kvNamespaceId.toLowerCase()!==backup.toLowerCase(),'backup_isolation_failed');
 if(destination)check(destination!==staging.databaseId,'destination_isolation_failed');
}
// Every wait remains bounded. Settling is a precaution, not a proof of global
// KV consistency. The operator must pause dashboard/API writers and deployments.
export async function settlePausedSource(freezeId,wait=ms=>new Promise(r=>setTimeout(r,ms)),fetcher=fetch){
 for(let n=0;n<3;n++){await assertPaused(freezeId,fetcher);await wait(40000);}
 await assertPaused(freezeId,fetcher);
}
