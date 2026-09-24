import { sanitizeItem, sanitizeTripContent, ITEM_FIELDS, ITEM_ID_FIELDS } from '../worker.js';

export const KINDS = Object.freeze({ destination:'destinations', activity:'activities', transport:'transport', accommodation:'accommodation', companion:'companions', contact:'contacts', expense:'expenses' });
export const ITINERARY = ['destination','activity','transport','accommodation'];
export const META_FIELDS = ['name','startDate','endDate','homeCurrency','notes','currencyRates'];
export class APIError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
export function fail(status, code, message) { throw new APIError(status,code,message); }
export function object(value) { return value !== null && typeof value==='object' && !Array.isArray(value); }
export function id(value) {
  if (typeof value==='number' && !Number.isSafeInteger(value)) fail(400,'invalid_id','Invalid identifier.');
  const text=String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) fail(400,'invalid_id','Invalid identifier.');
  return text;
}
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (object(value)) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export async function hash(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function date(value, timeOnly=false) {
  if (value==='' || value===undefined || value===null) return;
  if (typeof value!=='string') fail(400,'invalid_date','Dates must be strings.');
  if (timeOnly) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(400,'invalid_date','Invalid local time.');
    return;
  }
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/.exec(value);
  if (!match || match[1]==='0000') fail(400,'invalid_date','Invalid local date.');
  const check=new Date(value.slice(0,10)+'T00:00:00Z');
  if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0,10)!==value.slice(0,10)) fail(400,'invalid_date','Invalid calendar date.');
}
export function validateData(kind, recordID, patch, previous={}) {
  if (!object(patch)) fail(400,'invalid_data','data must be an object.');
  const allowed=kind==='trip' ? META_FIELDS : ITEM_FIELDS[KINDS[kind]];
  for (const key of Object.keys(patch)) {
    if (!allowed?.includes(key) || key==='accountId') fail(400,'unknown_field','Unsupported or server-managed field: '+key);
    const value=patch[key];
    if (typeof value==='string' && value.length>(key==='notes'?10000:1000)) fail(400,'invalid_data','Field is too long: '+key);
    if (key==='companions' && (!Array.isArray(value) || value.length>100)) fail(400,'invalid_data','Invalid participants.');
    if (/Date$/.test(key) || key==='date' || ['joinsOn','leavesOn','checkIn','checkOut','departDateTime','arriveDateTime'].includes(key)) date(value);
    else if (/Time$/.test(key)) date(value,true);
  }
  const merged={...previous,...patch};
  try {
    if (kind==='trip') {
      const clean=sanitizeTripContent(merged);
      if (clean.startDate && clean.endDate && clean.endDate<clean.startDate) fail(400,'invalid_date','Trip end precedes start.');
      if (!clean.name.trim()) fail(400,'invalid_data','Trip name is required.');
      return Object.fromEntries(META_FIELDS.map(k=>[k,clean[k]]));
    }
    const key=ITEM_ID_FIELDS[KINDS[kind]];
    if (patch[key]!==undefined && id(patch[key])!==recordID) fail(400,'invalid_id','Record identifier cannot change.');
    const clean=sanitizeItem(KINDS[kind],{...merged,[key]:recordID});
    for (const [lat,lng] of [['lat','lng'],['addressLat','addressLng'],['fromLat','fromLng'],['toLat','toLng']]) {
      const hasLat=clean[lat]!==undefined && clean[lat]!=='';
      const hasLng=clean[lng]!==undefined && clean[lng]!=='';
      if (hasLat!==hasLng) fail(400,'invalid_coordinate','Latitude and longitude must be supplied together.');
    }
    if (kind==='destination' && clean.arriveDate && clean.departDate && clean.departDate<clean.arriveDate) fail(400,'invalid_date','Destination departure precedes arrival.');
    if (kind==='accommodation' && clean.checkIn && clean.checkOut && clean.checkOut<clean.checkIn) fail(400,'invalid_date','Check-out precedes check-in.');
    // Keep imported extension fields; clients cannot introduce arbitrary keys.
    return {...previous,...clean};
  } catch (error) {
    if (error instanceof APIError) throw error;
    fail(400,'invalid_data',error.message);
  }
}
export function mutation(value) {
  if (!object(value)) fail(400,'invalid_mutation','Invalid mutation.');
  for (const key of Object.keys(value)) if (!['mutationId','tripId','kind','recordId','operation','baseRevision','data'].includes(key)) fail(400,'invalid_mutation','Unknown mutation field: '+key);
  const out={...value,mutationId:id(value.mutationId),tripId:id(value.tripId),recordId:id(value.recordId)};
  if (out.kind!=='trip' && !Object.hasOwn(KINDS,out.kind)) fail(400,'invalid_kind','Unsupported record kind.');
  if (!['create','update','delete'].includes(out.operation)) fail(400,'invalid_operation','Use create, update or delete.');
  if (!Number.isSafeInteger(out.baseRevision) || out.baseRevision<0 || (out.operation==='create' ? out.baseRevision!==0 : out.baseRevision===0)) fail(400,'invalid_revision','Invalid base revision.');
  if (out.kind==='trip' && out.recordId!==out.tripId) fail(400,'invalid_id','Trip identity must match.');
  if (out.operation==='delete' && out.data!==undefined) fail(400,'invalid_data','Deletion must not include data.');
  if (out.operation!=='delete' && !object(out.data)) fail(400,'invalid_data','data must be an object.');
  return out;
}
export async function readJSON(request, max=256*1024) {
  if (!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json')) fail(415,'content_type','Use application/json.');
  if (!request.body) fail(400,'invalid_json','Missing JSON body.');
  const reader=request.body.getReader(); const chunks=[]; let length=0;
  while (true) {
    const {done,value}=await reader.read(); if (done) break;
    length+=value.byteLength;
    if (length>max) { await reader.cancel(); fail(413,'body_too_large','Request body is too large.'); }
    chunks.push(value);
  }
  const buffer=new Uint8Array(length); let offset=0;
  for (const chunk of chunks) { buffer.set(chunk,offset); offset+=chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)); }
  catch { fail(400,'invalid_json','Invalid JSON.'); }
}
function base64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
function unbase64(text) { return Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)); }
async function key(secret) { return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
export async function signCursor(payload,secret) {
  const encoded=base64(new TextEncoder().encode(JSON.stringify(payload)));
  const signature=await crypto.subtle.sign('HMAC',await key(secret),new TextEncoder().encode('waypoint-sync-v1:'+encoded));
  return encoded+'.'+base64(new Uint8Array(signature));
}
export async function readCursor(text,secret,accountID,type) {
  try {
    if (typeof text!=='string' || text.length>4096) throw new Error();
    const parts=text.split('.'); if (parts.length!==2) throw new Error();
    if (!await crypto.subtle.verify('HMAC',await key(secret),unbase64(parts[1]),new TextEncoder().encode('waypoint-sync-v1:'+parts[0]))) throw new Error();
    const value=JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    if (value.v!==1 || value.uid!==accountID || value.type!==type || !Number.isSafeInteger(value.seq) || value.seq<0 || !Number.isSafeInteger(value.epoch)) throw new Error();
    return value;
  } catch { fail(400,'invalid_cursor','Invalid or wrong-account cursor.'); }
}
