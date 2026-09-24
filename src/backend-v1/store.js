import { APIError, fail, id, canonical, hash, mutation, validateData, ITINERARY, signCursor, readCursor } from './protocol.js';

const META=`SELECT dataset_id,epoch,retention_floor,coalesce((SELECT MAX(sequence) FROM changes),0) AS sequence FROM sync_state WHERE singleton=1`;
const FULL=`(?2=1 OR t.owner_id=?1 OR g.role='admin')`;
const ACCESS=`(?2=1 OR t.owner_id=?1 OR g.account_id IS NOT NULL)`;
const ROLE=`CASE WHEN ?2=1 OR t.owner_id=?1 THEN 'superuser' ELSE g.role END`;
const GRANT=`LEFT JOIN trip_grants g ON g.trip_id=t.id AND g.account_id=?1`;
const TAGGED=`EXISTS(SELECT 1 FROM record_tags rt WHERE rt.trip_id=r.trip_id AND rt.kind=r.kind AND rt.record_id=r.id AND rt.companion_id=g.companion_id)`;
const VISIBLE=`(${FULL} OR r.kind='companion' OR (r.kind IN ('destination','activity','transport','accommodation') AND ${TAGGED}) OR (r.kind='contact' AND EXISTS(
  SELECT 1 FROM records vr JOIN record_tags vt ON vt.trip_id=vr.trip_id AND vt.kind=vr.kind AND vt.record_id=vr.id
  WHERE vr.trip_id=r.trip_id AND vr.deleted=0 AND vr.kind IN ('activity','accommodation','transport') AND vt.companion_id=g.companion_id AND json_extract(vr.payload_json,'$.contactId')=r.id)))`;

function entities(includeDeleted=false) {
  return `SELECT t.id AS trip_id,'trip' AS kind,t.id AS id,t.metadata_json AS payload_json,t.revision,t.deleted,t.updated_at,${ROLE} AS role,g.companion_id,
    t.id||'|trip|'||t.id AS key FROM trips t ${GRANT} WHERE ${ACCESS} ${includeDeleted?'':'AND t.deleted=0'}
    UNION ALL SELECT r.trip_id,r.kind,r.id,r.payload_json,r.revision,r.deleted,r.updated_at,${ROLE} AS role,g.companion_id,
    r.trip_id||'|'||r.kind||'|'||r.id AS key FROM records r JOIN trips t ON t.id=r.trip_id ${GRANT}
    WHERE t.deleted=0 AND ${ACCESS} AND ${VISIBLE} ${includeDeleted?'':'AND r.deleted=0'}`;
}
function publicEntity(row) {
  const result={tripId:row.trip_id,kind:row.kind,recordId:row.id,revision:row.revision,operation:row.deleted?'delete':'upsert',updatedAt:row.updated_at};
  if (!row.deleted) {
    result.data=JSON.parse(row.payload_json);
    if (row.kind==='companion' && !['superuser','admin'].includes(row.role)) delete result.data.accountId;
    if (row.kind==='trip') result.permission={role:row.role,companionId:row.companion_id||''};
  }
  return result;
}
function limit(value) {
  if (value===null) return 50;
  const number=Number(value);
  if (!Number.isInteger(number)||number<1||number>100) fail(400,'invalid_limit','limit must be 1–100.');
  return number;
}
function metadata(result) {
  const row=result.results[0]; if (!row) fail(503,'schema_missing','Apply the staging database migrations first.');
  return row;
}
function checkCursor(cursor,meta) {
  if (cursor.dataset!==meta.dataset_id || cursor.epoch!==meta.epoch || cursor.seq<meta.retention_floor || cursor.seq>meta.sequence) {
    fail(409,'bootstrap_required','Permissions or database history changed. Replace the authorized cache through a new bootstrap.');
  }
}

export class SyncStore {
  constructor(db,user,secret) { this.db=db; this.user=user; this.secret=secret; }
  args() { return [this.user.id,this.user.isUberUser?1:0]; }
  cursor(meta,type,seq,extra={}) { return signCursor({v:1,uid:this.user.id,dataset:meta.dataset_id,epoch:meta.epoch,type,seq,...extra},this.secret); }

  async bootstrap(url) {
    const pageSize=limit(url.searchParams.get('limit'));
    const cursor=url.searchParams.has('cursor') ? await readCursor(url.searchParams.get('cursor'),this.secret,this.user.id,'bootstrap') : null;
    const [state,rows]=await this.db.batch([
      this.db.prepare(META),
      this.db.prepare(`SELECT * FROM (${entities()}) WHERE key>?3 ORDER BY key LIMIT ?4`).bind(...this.args(),cursor?.after||'',pageSize+1),
    ]);
    const meta=metadata(state);
    if (cursor) {
      checkCursor(cursor,meta);
      if (cursor.seq!==meta.sequence) fail(409,'bootstrap_required','Data changed while paging the snapshot. Restart bootstrap; do not publish incomplete pages.');
    }
    const hasMore=rows.results.length>pageSize;
    const page=rows.results.slice(0,pageSize);
    return {protocolVersion:1,entities:page.map(publicEntity),complete:!hasMore,
      nextCursor:hasMore?await this.cursor(meta,'bootstrap',meta.sequence,{after:page.at(-1).key}):null,
      syncCursor:hasMore?null:await this.cursor(meta,'changes',meta.sequence)};
  }

  async changes(url) {
    const cursor=await readCursor(url.searchParams.get('cursor'),this.secret,this.user.id,'changes');
    const pageSize=limit(url.searchParams.get('limit'));
    const [state,rows]=await this.db.batch([
      this.db.prepare(META),
      this.db.prepare(`SELECT e.*,c.sequence FROM changes c JOIN (${entities(true)}) e
        ON e.trip_id=c.trip_id AND e.kind=c.kind AND e.id=c.record_id
        WHERE c.sequence>?3 ORDER BY c.sequence LIMIT ?4`).bind(...this.args(),cursor.seq,pageSize+1),
    ]);
    const meta=metadata(state); checkCursor(cursor,meta);
    const hasMore=rows.results.length>pageSize; const page=rows.results.slice(0,pageSize);
    return {protocolVersion:1,entities:page.map(publicEntity),hasMore,
      cursor:await this.cursor(meta,'changes',hasMore?page.at(-1).sequence:meta.sequence)};
  }

  async trips(url) {
    const pageSize=limit(url.searchParams.get('limit'));
    const after=url.searchParams.get('after')||''; if (after) id(after);
    const rows=await this.db.prepare(`SELECT * FROM (${entities()}) WHERE kind='trip' AND id>?3 ORDER BY id LIMIT ?4`).bind(...this.args(),after,pageSize+1).all();
    const page=rows.results.slice(0,pageSize);
    return {trips:page.map(publicEntity),nextAfter:rows.results.length>pageSize?page.at(-1).id:null};
  }

  async context(change) {
    const [state,trips,records]=await this.db.batch([
      this.db.prepare(META),
      this.db.prepare(`SELECT t.*,${ROLE} AS role,g.companion_id FROM trips t ${GRANT} WHERE t.id=?3 AND ${ACCESS}`).bind(...this.args(),change.tripId),
      this.db.prepare(`SELECT * FROM records WHERE trip_id=? AND kind=? AND id=?`).bind(change.tripId,change.kind,change.recordId),
    ]);
    return {meta:metadata(state),trip:trips.results[0],record:records.results[0]};
  }

  async receipt(change,requestHash) {
    const row=await this.db.prepare('SELECT request_hash,response_json FROM mutation_receipts WHERE account_id=? AND mutation_id=?').bind(this.user.id,change.mutationId).first();
    if (!row) return null;
    if (row.request_hash!==requestHash) fail(409,'mutation_id_reused','This mutation ID already belongs to a different request.');
    return {...JSON.parse(row.response_json),duplicate:true};
  }

  async apply(input) {
    const change=mutation(input); const requestHash=await hash(change);
    const ctx=await this.context(change); const {trip,record,meta}=ctx;
    if (change.kind!=='trip' || change.operation!=='create') {
      if (!trip) fail(404,'not_found','Trip unavailable.');
      if (trip.role==='viewer') fail(403,'forbidden','Read-only trip.');
      if (trip.role==='user') {
        if (!ITINERARY.includes(change.kind) || change.operation!=='update' || !record || record.deleted) fail(403,'forbidden','Only existing tagged itinerary items can be edited.');
        const tags=JSON.parse(record.payload_json).companions||[];
        if (!tags.includes(trip.companion_id)) fail(403,'forbidden','Item is outside your access.');
        if (change.data.companions!==undefined && canonical(change.data.companions)!==canonical(tags)) fail(403,'forbidden','Participant tags cannot be changed with this role.');
      }
      if (change.kind==='trip' && change.operation==='delete' && trip.role!=='superuser') fail(403,'forbidden','Only the trip owner can delete a trip.');
    }
    const existingReceipt=await this.receipt(change,requestHash);
    if (existingReceipt) return existingReceipt;
    if (trip?.deleted) fail(409,'deleted','Trip was deleted.');
    const current=change.kind==='trip'?trip:record;
    if (change.operation==='create') {
      // Includes tombstones: stable IDs are never recycled.
      const exists=change.kind==='trip'
        ? await this.db.prepare('SELECT id FROM trips WHERE id=?').bind(change.tripId).first() : current;
      if (exists) fail(409,'already_exists','That identifier already exists.');
    } else if (!current || current.deleted || current.revision!==change.baseRevision) {
      fail(409,'revision_conflict','Record changed or was deleted. Refresh before resolving your draft.');
    }
    const now=new Date().toISOString();
    const data=change.operation==='delete'?null:validateData(change.kind,change.recordId,change.data,current?JSON.parse(change.kind==='trip'?current.metadata_json:current.payload_json):{});
    if (data && new TextEncoder().encode(JSON.stringify(data)).byteLength>32768) fail(413,'record_too_large','A record must be no larger than 32 KiB.');
    const references=[];
    if (data && change.kind!=='trip') {
      for (const [field,kind] of [['contactId','contact'],['destinationId','destination']]) {
        if (change.kind!==kind && data[field]) references.push([kind,id(data[field])]);
      }
      for (const companion of data.companions||[]) if (companion!=='__trip_superuser__') references.push(['companion',id(companion)]);
      for (const [kind,recordId] of references) {
        const visible=await this.db.prepare(`SELECT id FROM (${entities()}) WHERE trip_id=?3 AND kind=?4 AND id=?5`).bind(...this.args(),change.tripId,kind,recordId).first();
        if (!visible) fail(400,'invalid_reference','A referenced record is unavailable.');
      }
    }
    const unusedCompanion=`NOT EXISTS(SELECT 1 FROM trip_grants WHERE trip_id=? AND companion_id=?) AND NOT EXISTS(
      SELECT 1 FROM record_tags rt JOIN records r ON r.trip_id=rt.trip_id AND r.kind=rt.kind AND r.id=rt.record_id
      WHERE rt.trip_id=? AND rt.companion_id=? AND r.deleted=0)`;
    const deletingCompanion=change.kind==='companion' && change.operation==='delete';
    const companionArgs=[change.tripId,change.recordId,change.tripId,change.recordId];
    if (deletingCompanion && !(await this.db.prepare(`SELECT ${unusedCompanion} AS unused`).bind(...companionArgs).first()).unused) fail(409,'participant_in_use','Remove participant tags and sharing grants before deleting this participant.');
    const revision=change.baseRevision+1;
    const result={mutationId:change.mutationId,status:'applied',tripId:change.tripId,kind:change.kind,recordId:change.recordId,revision};
    const token=crypto.randomUUID();
    let condition; let conditionArgs;
    if (change.kind==='trip') {
      condition=change.operation==='create'?'NOT EXISTS(SELECT 1 FROM trips WHERE id=?)':'EXISTS(SELECT 1 FROM trips WHERE id=? AND revision=? AND deleted=0)';
      conditionArgs=change.operation==='create'?[change.tripId]:[change.tripId,change.baseRevision];
    } else {
      condition=`EXISTS(SELECT 1 FROM trips WHERE id=? AND deleted=0) AND `+(change.operation==='create'
        ?'NOT EXISTS(SELECT 1 FROM records WHERE trip_id=? AND kind=? AND id=?)'
        :'EXISTS(SELECT 1 FROM records WHERE trip_id=? AND kind=? AND id=? AND revision=? AND deleted=0)');
      conditionArgs=[change.tripId,change.tripId,change.kind,change.recordId,...(change.operation==='create'?[]:[change.baseRevision])];
    }
    for (const [kind,recordId] of references) {
      condition+=' AND EXISTS(SELECT 1 FROM records WHERE trip_id=? AND kind=? AND id=? AND deleted=0)';
      conditionArgs.push(change.tripId,kind,recordId);
    }
    if (deletingCompanion) { condition+=` AND ${unusedCompanion}`;conditionArgs.push(...companionArgs); }
    const statements=[this.db.prepare(`INSERT INTO write_guards(token,ok) SELECT ?,CASE WHEN
      (SELECT epoch FROM sync_state WHERE singleton=1)=? AND ${condition}
      AND NOT EXISTS(SELECT 1 FROM mutation_receipts WHERE account_id=? AND mutation_id=?) THEN 1 ELSE 0 END`)
      .bind(token,meta.epoch,...conditionArgs,this.user.id,change.mutationId)];
    if (change.kind==='trip') {
      if (change.operation==='create') statements.push(this.db.prepare('INSERT INTO trips(id,owner_id,metadata_json,revision,updated_at) VALUES(?,?,?,?,?)').bind(change.tripId,this.user.id,JSON.stringify(data),revision,now));
      else if (change.operation==='delete') statements.push(this.db.prepare('UPDATE trips SET deleted=1,revision=?,updated_at=? WHERE id=?').bind(revision,now,change.tripId));
      else statements.push(this.db.prepare('UPDATE trips SET metadata_json=?,revision=?,updated_at=? WHERE id=?').bind(JSON.stringify(data),revision,now,change.tripId));
    } else {
      if (change.operation==='create') statements.push(this.db.prepare('INSERT INTO records(trip_id,kind,id,payload_json,revision,updated_at) VALUES(?,?,?,?,?,?)').bind(change.tripId,change.kind,change.recordId,JSON.stringify(data),revision,now));
      else if (change.operation==='delete') statements.push(this.db.prepare('UPDATE records SET deleted=1,revision=?,updated_at=? WHERE trip_id=? AND kind=? AND id=?').bind(revision,now,change.tripId,change.kind,change.recordId));
      else statements.push(this.db.prepare('UPDATE records SET payload_json=?,revision=?,updated_at=? WHERE trip_id=? AND kind=? AND id=?').bind(JSON.stringify(data),revision,now,change.tripId,change.kind,change.recordId));
    }
    statements.push(this.db.prepare('INSERT INTO mutation_receipts VALUES(?,?,?,?,?)').bind(this.user.id,change.mutationId,requestHash,JSON.stringify(result),now));
    statements.push(this.db.prepare('DELETE FROM write_guards WHERE token=?').bind(token));
    try { await this.db.batch(statements); }
    catch (error) {
      const replay=await this.receipt(change,requestHash); if (replay) return replay;
      if (/CHECK constraint failed|UNIQUE constraint failed/.test(error.message)) fail(409,'concurrent_change','Data or permissions changed during this request. Refresh and review the draft.');
      throw error;
    }
    return result;
  }

  async mutations(body) {
    if (body?.protocolVersion!==1 || !Array.isArray(body.mutations) || body.mutations.length<1 || body.mutations.length>20) fail(400,'invalid_batch','Supply protocolVersion 1 and 1–20 mutations.');
    const results=[];
    for (const input of body.mutations) {
      try { results.push(await this.apply(input)); }
      catch (error) {
        if (!(error instanceof APIError)) throw error;
        results.push({mutationId:typeof input?.mutationId==='string'?input.mutationId.slice(0,128):null,status:error.status===409?'conflict':'rejected',error:{code:error.code,message:error.message,httpStatus:error.status}});
      }
    }
    return {protocolVersion:1,results};
  }

  async setGrant(tripID,body,accounts) {
    const tripId=id(tripID); const accountId=id(body?.accountId);
    if (!accounts.some(a=>a.id===accountId)) fail(400,'invalid_account','Account unavailable.');
    if (!['admin','user','viewer',null].includes(body.role)) fail(400,'invalid_role','Unsupported role.');
    const companionId=body.role==='user'||body.role==='viewer'?id(body.companionId):'';
    const {trip,meta}=await this.context({tripId,kind:'trip',recordId:tripId});
    if (!trip || trip.deleted) fail(404,'not_found','Trip unavailable.');
    if (trip.role!=='superuser') fail(403,'forbidden','Sharing changes are owner-only in this staging API.');
    if (trip.owner_id===accountId) fail(400,'invalid_account','The owner already has access.');
    if (companionId && !await this.db.prepare("SELECT id FROM records WHERE trip_id=? AND kind='companion' AND id=? AND deleted=0").bind(tripId,companionId).first()) fail(400,'invalid_participant','Participant unavailable.');
    const token=crypto.randomUUID();
    const statements=[this.db.prepare('INSERT INTO write_guards SELECT ?,CASE WHEN (SELECT epoch FROM sync_state WHERE singleton=1)=? AND EXISTS(SELECT 1 FROM trips WHERE id=? AND deleted=0) THEN 1 ELSE 0 END').bind(token,meta.epoch,tripId)];
    if (body.role===null) statements.push(this.db.prepare('DELETE FROM trip_grants WHERE trip_id=? AND account_id=?').bind(tripId,accountId));
    else statements.push(this.db.prepare('INSERT INTO trip_grants VALUES(?,?,?,?) ON CONFLICT(trip_id,account_id) DO UPDATE SET role=excluded.role,companion_id=excluded.companion_id').bind(tripId,accountId,body.role,companionId));
    statements.push(this.db.prepare('DELETE FROM write_guards WHERE token=?').bind(token));
    try { await this.db.batch(statements); }
    catch(error) { if (/CHECK constraint failed/.test(error.message)) fail(409,'concurrent_change','Permissions changed. Retry after refreshing.'); throw error; }
    return {status:'ok',bootstrapRequired:true};
  }
}
