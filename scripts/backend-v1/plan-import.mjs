#!/usr/bin/env node
// Private backup -> deterministic D1 import plan. This script never connects to
// Cloudflare and never applies a plan. Production execution is a separate gate.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { KINDS, META_FIELDS, canonical, id, object } from '../../src/backend-v1/protocol.js';

// Diagnostics contain only fixed labels and one-based positions, never source values.
export class SourceValidationError extends Error {
  constructor(code,message,location={}) { super(message); this.name='SourceValidationError'; this.code=code; this.location=Object.freeze({...location}); }
}
function fail(code,message,location) { throw new SourceValidationError(code,message,location); }
function sourceId(value,location) {
  try { return id(value); } catch { fail('invalid_source_id','Invalid source identity.',location); }
}
export function buildImport(snapshot) {
  if (snapshot?.format!=='waypoint-kv-export-v1' || !object(snapshot.entries)) fail('invalid_export','Expected a complete waypoint-kv-export-v1 backup.');
  function parse(key,location) {
    if (typeof snapshot.entries[key]!=='string') fail('missing_source_key','Missing source key.',location);
    try { return JSON.parse(snapshot.entries[key]); } catch { fail('invalid_source_json','Invalid JSON in source.',location); }
  }
  const index=parse('trip_index',{source:'trip_index'}); const users=parse('users',{source:'users'});
  if (!object(index)||!Array.isArray(index.trips)) fail('invalid_trip_index','Invalid trip index.',{source:'trip_index'});
  if (!object(users)||!Array.isArray(users.users)) fail('invalid_account_index','Invalid account index.',{source:'users'});
  const accounts=new Set();
  for (const [n,user] of users.users.entries()) { const location={source:'users',accountNumber:n+1}; if (!object(user)) fail('invalid_account','Invalid account.',location); const uid=sourceId(user.id,{...location,field:'id'}); if (accounts.has(uid)) fail('duplicate_account_id','Duplicate account identity.',location); accounts.add(uid); }
  const sourceHash=createHash('sha256').update(canonical(snapshot.entries)).digest('hex');
  const statements=[]; const tripIDs=new Set();
  const counts={trips:0,records:0,grants:0,byKind:{}};
  const timestamp='1970-01-01T00:00:00.000Z'; // Imported items have no trustworthy modification time.
  for (const [n,entry] of index.trips.entries()) {
    const indexLocation={source:'trip_index',tripNumber:n+1};
    const location={source:'trip_content',tripNumber:n+1};
    if (!object(entry)) fail('invalid_trip_entry','Invalid trip entry.',indexLocation);
    const tripId=sourceId(entry.tripId,{...indexLocation,field:'tripId'}); const ownerId=sourceId(entry.ownerId,{...indexLocation,field:'ownerId'});
    if (tripIDs.has(tripId)) fail('duplicate_trip_id','Duplicate trip identity.',indexLocation); tripIDs.add(tripId);
    if (!accounts.has(ownerId)) fail('missing_trip_owner','A trip owner is missing from the account export.',{...indexLocation,field:'ownerId'});
    const content=parse('trip:'+tripId,location);
    if (!object(content)) fail('invalid_trip_content','Invalid trip content.',location);
    const metadata=Object.fromEntries(META_FIELDS.filter(k=>Object.hasOwn(content,k)).map(k=>[k,content[k]]));
    const extras=Object.fromEntries(Object.entries(content).filter(([k])=>!META_FIELDS.includes(k)&&!Object.values(KINDS).includes(k)));
    // Preserve index extensions as well; no private grant fields enter API metadata.
    if (Object.hasOwn(extras,'_legacyIndex')) fail('reserved_source_field','Reserved source field needs explicit mapping before migration.',{...location,field:'_legacyIndex'});
    extras._legacyIndex=entry;
    statements.push({sql:'INSERT INTO trips(id,owner_id,metadata_json,legacy_extras_json,revision,updated_at) VALUES(?,?,?,?,1,?)',params:[tripId,ownerId,canonical(metadata),canonical(extras),timestamp]});
    counts.trips++;
    const companions=new Set();
    const allRecords=[];
    for (const [kind,list] of Object.entries(KINDS)) {
      const records=content[list]??[];
      if (!Array.isArray(records)) fail('invalid_record_collection','Invalid record collection.',{...location,collection:list});
      const identities=new Set();
      for (const [recordIndex,original] of records.entries()) {
        const recordLocation={...location,collection:list,recordNumber:recordIndex+1};
        if (!object(original)) fail('invalid_record','Invalid record.',recordLocation);
        const key=kind+'Id'; const recordId=sourceId(original[key],{...recordLocation,field:key});
        if (identities.has(recordId)) fail('duplicate_record_id','Duplicate record identity.',{...recordLocation,field:key}); identities.add(recordId);
        const normalized={...original,[key]:recordId};
        if (normalized.companions!==undefined) {
          if (!Array.isArray(normalized.companions)) fail('invalid_participant_tags','Invalid participant tags.',{...recordLocation,field:'companions'});
          normalized.companions=normalized.companions.map((value,tagIndex)=>sourceId(value,{...recordLocation,field:'companions',tagNumber:tagIndex+1}));
        }
        for (const ref of ['destinationId','contactId','accountId']) {
          if (normalized[ref]!==undefined && normalized[ref]!=='' && normalized[ref]!==null) normalized[ref]=sourceId(normalized[ref],{...recordLocation,field:ref});
        }
        if (kind==='companion') {
          companions.add(recordId);
          if (normalized.accountId && !accounts.has(normalized.accountId)) fail('missing_linked_account','A linked participant account is missing.',{...recordLocation,field:'accountId'});
        }
        allRecords.push({kind,recordId,normalized,recordLocation});
        statements.push({sql:'INSERT INTO records(trip_id,kind,id,payload_json,revision,updated_at) VALUES(?,?,?,?,1,?)',params:[tripId,kind,recordId,canonical(normalized),timestamp]});
        counts.records++; counts.byKind[kind]=(counts.byKind[kind]||0)+1;
      }
    }
    for (const {normalized,recordLocation} of allRecords) {
      for (const [tagIndex,participant] of (normalized.companions||[]).entries()) if (participant!=='__trip_superuser__'&&!companions.has(participant)) fail('missing_record_participant','A record references a missing participant. Repair the source before migration.',{...recordLocation,field:'companions',tagNumber:tagIndex+1});
    }
    const grants=entry.grants??[]; if (!Array.isArray(grants)) fail('invalid_grants','Invalid grants.',{...indexLocation,field:'grants'});
    const granted=new Set();
    for (const [grantIndex,grant] of grants.entries()) {
      const grantLocation={...indexLocation,grantNumber:grantIndex+1};
      if (!object(grant)) fail('invalid_grant','Invalid grant.',grantLocation);
      const accountId=sourceId(grant.accountId,{...grantLocation,field:'accountId'});
      if (!accounts.has(accountId)) fail('missing_grant_account','Grant account is missing.',{...grantLocation,field:'accountId'});
      if (granted.has(accountId)) fail('duplicate_grant_account','Duplicate grant account.',{...grantLocation,field:'accountId'});
      if (accountId===ownerId) fail('owner_grant','Owner has a redundant grant.',{...grantLocation,field:'accountId'});
      granted.add(accountId);
      if (!['admin','user','viewer'].includes(grant.role)) fail('invalid_grant_role','Invalid grant role.',{...grantLocation,field:'role'});
      const companionId=grant.companionId?sourceId(grant.companionId,{...grantLocation,field:'companionId'}):'';
      if (['user','viewer'].includes(grant.role)&&!companions.has(companionId)) fail('missing_grant_participant','A scoped grant references a missing participant.',{...grantLocation,field:'companionId'});
      statements.push({sql:'INSERT INTO trip_grants(trip_id,account_id,role,companion_id) VALUES(?,?,?,?)',params:[tripId,accountId,grant.role,companionId]}); counts.grants++;
    }
  }
  const extraTripKeys=Object.keys(snapshot.entries).filter(k=>k.startsWith('trip:')&&!tripIDs.has(k.slice(5)));
  if (extraTripKeys.length) fail('unindexed_trip_keys','Unindexed trip keys exist. Review them before migration; do not silently discard them.',{source:'trip_index',count:extraTripKeys.length});
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
  } catch(error) { console.error(JSON.stringify(error instanceof SourceValidationError?{status:'failed',code:error.code,location:error.location}:{status:'failed',code:'plan_creation_failed'})); process.exitCode=1; }
}
