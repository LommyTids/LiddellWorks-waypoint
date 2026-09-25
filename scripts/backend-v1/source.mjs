import { check } from './cloudflare.mjs';
const core=key=>key==='users'||key==='users_initialized'||key==='trip_index'||key.startsWith('trip:');
async function list(api,base){
  const keys=[];let cursor='';const seen=new Set();
  do{const page=await api.request(base+'/keys?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));keys.push(...page.result.map(k=>k.name));cursor=page.result_info?.cursor||'';check(!cursor||!seen.has(cursor),'kv_pagination_error');seen.add(cursor);}while(cursor);
  return keys.sort();
}
export async function verifySourceStable(api,namespace,snapshot){
  const base='/storage/kv/namespaces/'+namespace;
  const current=(await list(api,base)).filter(core),previous=Object.keys(snapshot.entries).filter(core).sort();
  check(JSON.stringify(current)===JSON.stringify(previous),'source_changed');
  for(const key of current)check(await api.request(base+'/values/'+encodeURIComponent(key),{raw:true})===snapshot.entries[key],'source_changed');
}
export async function exportSnapshot(api,namespace){
  check(/^[a-f0-9]{32}$/i.test(namespace),'invalid_namespace');
  const base='/storage/kv/namespaces/'+namespace,keys=await list(api,base),entries=Object.create(null);let bytes=0;
  for(const key of keys){const value=await api.request(base+'/values/'+encodeURIComponent(key),{raw:true});bytes+=Buffer.byteLength(value);check(bytes<=100*1024*1024,'source_exceeds_rehearsal_limit');entries[key]=value;}
  check(entries.users&&entries.trip_index,'source_layout_unsupported');
  const snapshot={format:'waypoint-kv-export-v1',exportedAt:new Date().toISOString(),namespaceId:namespace,entries};
  await verifySourceStable(api,namespace,snapshot);return snapshot;
}
