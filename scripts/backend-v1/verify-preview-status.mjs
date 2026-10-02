import {readFile,appendFile} from 'node:fs/promises';
const pins=JSON.parse(await readFile(new URL('../../config/backend-production.json',import.meta.url),'utf8'));
let passed=false;
try{
 const response=await fetch('https://liddellworks.com/WayPoint/api/migration-status?check='+crypto.randomUUID(),{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(response.ok){const status=await response.json();passed=status.storage==='d1'&&status.writesPaused===true&&status.freezeId===pins.freezeId&&status.sourceHash===pins.sourceHash;}
}catch{}
console.log(JSON.stringify({status:passed?'read_only_preview_deployed':'preview_status_unverified',writesPaused:true,nextStep:passed?'Sign in and review the real trips. Do not enable saving.':'Deployment may have completed. Inspect the public migration-status endpoint and security events. Do not resume KV or enable saving.'}));
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,passed?'\nRead-only production D1 preview deployed. Sign in and review trips; saving remains disabled.\n':'\nPublic preview status could not be verified after deployment. No rollback or unpause was attempted. Inspect the live status before taking any further action.\n');
if(!passed)process.exitCode=1;
