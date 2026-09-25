#!/usr/bin/env node
// Private backup -> deterministic D1 import plan. This script never connects to
// Cloudflare and never applies a plan. Production execution is a separate gate.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { KINDS, META_FIELDS, canonical, id, object } from '../../src/backend-v1/protocol.js';

export function buildImport(snapshot) {
  if (snapshot?.format!=='waypoint-kv-export-v1' || !object(snapshot.entries)) throw new Error('Expected a complete waypoint-kv-export-v1 backup.');
  function parse(key) {
    if (typeof snapshot.entries[key]!=='string') throw new Error('Missing source key: '+key);
    try { return JSON.parse(snapshot.entries[key]); } catch { throw new Error('Invalid JSON in source key: '+key); }
  }
  const index=parse('trip_index'); const users=parse('users');
  if (!Array.isArray(index.trips)||!Array.isArray(users.users)) throw new Error('Invalid trip/account index.');
  const accounts=new Set();
  for (const user of users.users) { const uid=id(user.id); if (accounts.has(uid)) throw new Error('Duplicate account identity.'); accounts.add(uid); }
  const sourceHash=createHash('sha256').update(canonical(snapshot.entries)).digest('hex');
  const statements=[]; const tripIDs=new Set();
  const counts={trips:0,records:0,grants:0,byKind:{}};
  const timestamp='1970-01-01T00:00:00.000Z'; // Imported items have no trustworthy modification time.
  for (const entry of index.trips) {
    const tripId=id(entry.tripId); const ownerId=id(entry.ownerId);
    if (tripIDs.has(tripId)) throw new Error('Duplicate trip identity.'); tripIDs.add(tripId);
    if (!accounts.has(ownerId)) throw new Error('A trip owner is missing from the account export.');
    const content=parse('trip:'+tripId);
    if (!object(content)) throw new Error('Invalid trip content.');
    const metadata=Object.fromEntries(META_FIELDS.filter(k=>Object.hasOwn(content,k)).map(k=>[k,content[k]]));
    const extras=Object.fromEntries(Object.entries(content).filter(([k])=>!META_FIELDS.includes(k)&&!Object.values(KINDS).includes(k)));
    // Preserve index extensions as well; no private grant fields enter API metadata.
    if (Object.hasOwn(extras,'_legacyIndex')) throw new Error('Reserved source field needs explicit mapping before migration.');
    extras._legacyIndex=entry;
    statements.push({sql:'INSERT INTO trips(id,owner_id,metadata_json,legacy_extras_json,revision,updated_at) VALUES(?,?,?,?,1,?)',params:[tripId,ownerId,canonical(metadata),canonical(extras),timestamp]});
    counts.trips++;
    const companions=new Set();
    const allRecords=[];
    for (const [kind,list] of Object.entries(KINDS)) {
      const records=content[list]??[];
      if (!Array.isArray(records)) throw new Error('Invalid record collection.');
      const identities=new Set();
      for (const original of records) {
        if (!object(original)) throw new Error('Invalid record.');
        const key=kind+'Id'; const recordId=id(original[key]);
        if (identities.has(recordId)) throw new Error('Duplicate record identity.'); identities.add(recordId);
        const normalized={...original,[key]:recordId};
        if (normalized.companions!==undefined) {
          if (!Array.isArray(normalized.companions)) throw new Error('Invalid participant tags.');
          normalized.companions=normalized.companions.map(id);
        }
        for (const ref of ['destinationId','contactId','accountId']) {
          if (normalized[ref]!==undefined && normalized[ref]!=='' && normalized[ref]!==null) normalized[ref]=id(normalized[ref]);
        }
        if (kind==='companion') {
          companions.add(recordId);
          if (normalized.accountId && !accounts.has(normalized.accountId)) throw new Error('A linked participant account is missing.');
        }
        allRecords.push({kind,recordId,normalized});
        statements.push({sql:'INSERT INTO records(trip_id,kind,id,payload_json,revision,updated_at) VALUES(?,?,?,?,1,?)',params:[tripId,kind,recordId,canonical(normalized),timestamp]});
        counts.records++; counts.byKind[kind]=(counts.byKind[kind]||0)+1;
      }
    }
    for (const {normalized} of allRecords) {
      for (const participant of normalized.companions||[]) if (participant!=='__trip_superuser__'&&!companions.has(participant)) throw new Error('A record references a missing participant. Repair the source before migration.');
    }
    const grants=entry.grants??[]; if (!Array.isArray(grants)) throw new Error('Invalid grants.');
    const granted=new Set();
    for (const grant of grants) {
      const accountId=id(grant.accountId);
      if (!accounts.has(accountId)||granted.has(accountId)||accountId===ownerId) throw new Error('Invalid or duplicate grant account.');
      granted.add(accountId);
      if (!['admin','user','viewer'].includes(grant.role)) throw new Error('Invalid grant role.');
      const companionId=grant.companionId?id(grant.companionId):'';
      if (['user','viewer'].includes(grant.role)&&!companions.has(companionId)) throw new Error('A scoped grant references a missing participant.');
      statements.push({sql:'INSERT INTO trip_grants(trip_id,account_id,role,companion_id) VALUES(?,?,?,?)',params:[tripId,accountId,grant.role,companionId]}); counts.grants++;
    }
  }
  const extraTripKeys=Object.keys(snapshot.entries).filter(k=>k.startsWith('trip:')&&!tripIDs.has(k.slice(5)));
  if (extraTripKeys.length) throw new Error('Unindexed trip keys exist. Review them before migration; do not silently discard them.');
  statements.push({sql:'INSERT INTO import_manifest(id,source_hash,imported_at) VALUES(1,?,?)',params:[sourceHash,timestamp]});
  return {format:'waypoint-d1-import-plan-v1',sourceHash,counts,statements,
    requirements:['Empty destination database with 0001 schema applied','All source writers paused for final export','Use guarded resumable batches in an isolated destination; this planner does not apply it','Verify reconstructed payloads before cutover'],
    retainedInKV:['Account password hashes and session versions','Location/provider caches and boundary objects'],
    warning:'Private trip data is present in statement parameters. Never commit this plan or upload it as a public workflow artifact.'};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [input,output]=process.argv.slice(2);
    if (!input||!output) throw new Error('Usage: node scripts/backend-v1/plan-import.mjs PRIVATE_BACKUP.json PRIVATE_PLAN.json');
    const plan=buildImport(JSON.parse(await readFile(input,'utf8')));
    await writeFile(output,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({status:'plan-created',sourceHash:plan.sourceHash,counts:plan.counts}));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
