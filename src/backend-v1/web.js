import { buildVisibleTrip } from '../worker.js';
import { fail,id,readCursor } from './protocol.js';

const access=`(?2=1 OR t.owner_id=?1 OR EXISTS(SELECT 1 FROM trip_grants g WHERE g.trip_id=t.id AND g.account_id=?1))`;
export async function presentation(store,users,cursorText){
  const cursor=await readCursor(cursorText,store.secret,store.user.id,'changes');
  const args=store.args();
  const [state,trips,grants,companions]=await store.db.batch([
    store.db.prepare('SELECT dataset_id,epoch,coalesce((SELECT max(sequence) FROM changes),0) AS sequence FROM sync_state WHERE singleton=1'),
    store.db.prepare(`SELECT t.* FROM trips t WHERE t.deleted=0 AND ${access}`).bind(...args),
    store.db.prepare(`SELECT g.* FROM trip_grants g JOIN trips t ON t.id=g.trip_id WHERE t.deleted=0 AND ${access}`).bind(...args),
    store.db.prepare(`SELECT r.trip_id,r.payload_json FROM records r JOIN trips t ON t.id=r.trip_id WHERE t.deleted=0 AND r.deleted=0 AND r.kind='companion' AND ${access}`).bind(...args),
  ]);
  const meta=state.results[0];
  if(cursor.dataset!==meta.dataset_id||cursor.epoch!==meta.epoch||cursor.seq!==meta.sequence)fail(409,'bootstrap_required','Data changed during loading. Restart the snapshot.');
  const result=Object.create(null);
  for(const trip of trips.results){
    const mapped=grants.results.filter(g=>g.trip_id===trip.id).map(g=>({accountId:g.account_id,role:g.role,companionId:g.companion_id}));
    const perm=store.user.isUberUser||trip.owner_id===store.user.id?{role:'superuser'}:mapped.find(g=>g.accountId===store.user.id);
    const visible=buildVisibleTrip({tripId:trip.id,ownerId:trip.owner_id,grants:mapped},{companions:companions.results.filter(c=>c.trip_id===trip.id).map(c=>JSON.parse(c.payload_json))},perm,users);
    result[trip.id]=Object.fromEntries(['ownerId','ownerUsername','grants','companionAvatars','companionAccessLevels','superuserParticipant'].filter(k=>visible[k]!==undefined).map(k=>[k,visible[k]]));
  }
  return result;
}

// Identity links and grants are one transaction. Never delegate these to KV.
export async function setAccess(store,body,users){
  const tripId=id(body.tripId),companionId=id(body.companionId);
  const {trip,record,meta}=await store.context({tripId,kind:'companion',recordId:companionId});
  if(!trip||trip.deleted)fail(404,'not_found','Trip unavailable.');
  if(trip.role!=='superuser')fail(403,'forbidden','Only the owner manages access in staging.');
  if(!record||record.deleted)fail(404,'not_found','Participant unavailable.');
  if(body.baseRevision!==record.revision)fail(409,'revision_conflict','Participant changed. Refresh before changing access.');
  const username=String(body.username||'').trim();
  const account=username?users.users.find(u=>u.username.toLowerCase()===username.toLowerCase()):null;
  if(username&&!account)fail(400,'invalid_account','That staging username does not exist.');
  if(![undefined,'','admin','user','viewer'].includes(body.role))fail(400,'invalid_role','Unsupported access level.');
  if(body.role&&!account)fail(400,'invalid_account','Choose an account before granting access.');
  if(account&&(account.id===trip.owner_id||account.isUberUser)&&body.role)fail(400,'invalid_role','This account already has owner access. Leave its access level unchanged.');
  const data=JSON.parse(record.payload_json),previous=data.accountId;
  const token=crypto.randomUUID(),now=new Date().toISOString();
  const statements=[store.db.prepare(`INSERT INTO write_guards SELECT ?,CASE WHEN (SELECT epoch FROM sync_state WHERE singleton=1)=? AND EXISTS(SELECT 1 FROM trips WHERE id=? AND deleted=0) AND EXISTS(SELECT 1 FROM records WHERE trip_id=? AND kind='companion' AND id=? AND revision=? AND deleted=0) THEN 1 ELSE 0 END`).bind(token,meta.epoch,tripId,tripId,companionId,record.revision)];
  if(account){
    statements.push(store.db.prepare(`UPDATE records SET payload_json=json_remove(payload_json,'$.accountId'),revision=revision+1,updated_at=? WHERE trip_id=? AND kind='companion' AND deleted=0 AND id<>? AND json_extract(payload_json,'$.accountId')=?`).bind(now,tripId,companionId,account.id));
    data.accountId=account.id;
  }else delete data.accountId;
  statements.push(store.db.prepare(`UPDATE records SET payload_json=?,revision=revision+1,updated_at=? WHERE trip_id=? AND kind='companion' AND id=?`).bind(JSON.stringify(data),now,tripId,companionId));
  if(previous&&previous!==account?.id)statements.push(store.db.prepare('DELETE FROM trip_grants WHERE trip_id=? AND account_id=?').bind(tripId,previous));
  if(account){
    if(body.role==='')statements.push(store.db.prepare('DELETE FROM trip_grants WHERE trip_id=? AND account_id=?').bind(tripId,account.id));
    else if(body.role)statements.push(store.db.prepare(`INSERT INTO trip_grants VALUES(?,?,?,?) ON CONFLICT(trip_id,account_id) DO UPDATE SET role=excluded.role,companion_id=excluded.companion_id`).bind(tripId,account.id,body.role,companionId));
    else statements.push(store.db.prepare('UPDATE trip_grants SET companion_id=? WHERE trip_id=? AND account_id=?').bind(companionId,tripId,account.id));
  }
  statements.push(store.db.prepare('DELETE FROM write_guards WHERE token=?').bind(token));
  try{await store.db.batch(statements);}catch(e){if(/CHECK constraint failed/.test(e.message))fail(409,'concurrent_change','Data or access changed. Refresh and try again.');throw e;}
  return {status:'ok'};
}
