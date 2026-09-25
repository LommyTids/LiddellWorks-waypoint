#!/usr/bin/env node
import { readFile,writeFile } from 'node:fs/promises';

// Separate generated configuration: never modify wrangler.toml or its routes.
const defaults=JSON.parse(await readFile(new URL('../../config/backend-staging.json',import.meta.url),'utf8'));
const account=process.env.CLOUDFLARE_ACCOUNT_ID||defaults.accountId;
const kv=process.env.WAYPOINT_STAGING_KV_ID||defaults.kvNamespaceId;
const db=process.env.WAYPOINT_STAGING_D1_ID||defaults.databaseId;
if (!/^[a-f0-9]{32}$/i.test(account||'') || !/^[a-f0-9]{32}$/i.test(kv||'') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(db||'')) {
  throw new Error('Supply valid account, staging KV and staging D1 IDs in config/backend-staging.json or environment variables.');
}
const production=await readFile(new URL('../../wrangler.toml',import.meta.url),'utf8');
if (production.toLowerCase().includes(kv.toLowerCase()) || production.toLowerCase().includes(db.toLowerCase())) throw new Error('Staging must not use a production resource ID.');
await writeFile(new URL('../../wrangler.backend-staging.generated.json',import.meta.url),JSON.stringify({
  name:'waypoint-backend-staging',account_id:account,main:'src/backend-v1/worker.js',compatibility_date:'2026-08-27',workers_dev:true,
  assets:{directory:'./public',binding:'ASSETS',run_worker_first:true,html_handling:'none'},
  vars:{WAYPOINT_ENV:'staging'},kv_namespaces:[{binding:'WAYPOINT_KV',id:kv}],
  d1_databases:[{binding:'WAYPOINT_DB',database_name:'waypoint-backend-staging',database_id:db,migrations_dir:'migrations/backend-v1'}],
},null,2)+'\n');
console.log('Wrote isolated staging configuration. Production routes are not included.');
