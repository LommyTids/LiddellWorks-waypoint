#!/usr/bin/env node
// Requires a read-only Cloudflare KV token scoped to the source account.
// No secrets or data values are printed and no source keys are modified.
import { writeFile } from 'node:fs/promises';

const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const namespace=process.env.WAYPOINT_SOURCE_KV_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
const output=process.argv[2];
if (!/^[a-f0-9]{32}$/i.test(account||'')||!/^[a-f0-9]{32}$/i.test(namespace||'')||!token||!output) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID, WAYPOINT_SOURCE_KV_ID and a read-only CLOUDFLARE_API_TOKEN; pass a private output path.'); process.exit(1);
}
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`;
async function get(path,json=false) {
  for (let attempt=0;attempt<4;attempt++) {
    const response=await fetch(base+path,{headers:{Authorization:'Bearer '+token},redirect:'error'});
    if ((response.status===429||response.status>=500)&&attempt<3) { await new Promise(r=>setTimeout(r,1000*2**attempt)); continue; }
    if (!response.ok) throw new Error('Cloudflare export request failed with HTTP '+response.status+'. No source data was modified.');
    if (!json) return response.text();
    const body=await response.json(); if (!body.success) throw new Error('Cloudflare rejected the export request.'); return body;
  }
}
async function keys() {
  const names=[]; let cursor='';
  do {
    const page=await get('/keys?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''),true);
    names.push(...page.result.map(k=>k.name)); cursor=page.result_info?.cursor||'';
  } while(cursor);
  return names.sort();
}
try {
  const before=await keys(); const entries={};
  for (const name of before) entries[name]=await get('/values/'+encodeURIComponent(name));
  if (!entries.trip_index||!entries.users) throw new Error('Missing trip_index/users. This tool requires the current per-trip KV layout.');
  // Drift detection helps catch an accidental live export, but KV eventual
  // consistency means it is NOT a replacement for pausing all source writers.
  const after=await keys();
  if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('KV changed during export. Pause writers and retry.');
  for (const name of before.filter(k=>k==='trip_index'||k==='users'||k.startsWith('trip:'))) {
    if (entries[name]!==await get('/values/'+encodeURIComponent(name))) throw new Error('Trip/account data changed during export. Pause writers and retry.');
  }
  await writeFile(output,JSON.stringify({format:'waypoint-kv-export-v1',exportedAt:new Date().toISOString(),namespaceId:namespace,entries},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'exported',keys:before.length,warning:'Private backup; final cutover requires all writers paused and source reads settled.'}));
} catch(error) { console.error(error.message); process.exitCode=1; }
