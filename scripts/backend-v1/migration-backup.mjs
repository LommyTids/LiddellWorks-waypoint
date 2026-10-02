import { createHash,createPublicKey,createPrivateKey,randomBytes,publicEncrypt,privateDecrypt,createCipheriv,createDecipheriv,constants } from 'node:crypto';
import { canonical } from '../../src/backend-v1/protocol.js';
import { check,RehearsalError } from './cloudflare.mjs';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const MAX_BACKUP=150*1024*1024,CHUNK_BYTES=4*1024*1024;
const aad=Buffer.from('waypoint-migration-backup-v1');
export function encryptBackup(snapshot,pem){
 try{
  const publicKey=createPublicKey(pem);
  check(publicKey.asymmetricKeyType==='rsa'&&publicKey.asymmetricKeyDetails.modulusLength>=3072,'invalid_backup_public_key');
  const plaintext=Buffer.from(JSON.stringify(snapshot));check(plaintext.length<=100*1024*1024,'source_exceeds_rehearsal_limit');
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]),tag=cipher.getAuthTag();
  const verify=createDecipheriv('aes-256-gcm',key,iv);verify.setAAD(aad);verify.setAuthTag(tag);
  check(Buffer.concat([verify.update(ciphertext),verify.final()]).equals(plaintext),'backup_encryption_failed');
  const envelope={format:'waypoint-migration-backup-v1',algorithm:'RSA-OAEP-SHA256+A256GCM',keyFingerprint:sha256(publicKey.export({type:'spki',format:'der'})),sourceHash:sha256(canonical(snapshot.entries)),iv:iv.toString('base64'),tag:tag.toString('base64'),wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),ciphertext:ciphertext.toString('base64')};
  key.fill(0);plaintext.fill(0);return envelope;
 }catch(e){if(e instanceof RehearsalError)throw e;throw new RehearsalError('backup_encryption_failed');}
}
export function decryptBackup(envelope,pem){
 try{
  check(envelope?.format==='waypoint-migration-backup-v1'&&envelope.algorithm==='RSA-OAEP-SHA256+A256GCM','invalid_backup');
  const privateKey=createPrivateKey(pem),publicKey=createPublicKey(privateKey);
  check(sha256(publicKey.export({type:'spki',format:'der'}))===envelope.keyFingerprint,'backup_key_mismatch');
  const key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(envelope.wrappedKey,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
  const snapshot=JSON.parse(plaintext.toString('utf8'));key.fill(0);plaintext.fill(0);
  check(snapshot?.format==='waypoint-kv-export-v1'&&sha256(canonical(snapshot.entries))===envelope.sourceHash,'backup_source_hash_mismatch');return snapshot;
 }catch(e){if(e instanceof RehearsalError)throw e;throw new RehearsalError('backup_decryption_failed');}
}
export function backupParts(envelope,backupId){
 check(/^[a-z0-9-]{1,100}$/.test(backupId),'invalid_backup_id');
 const encoded=JSON.stringify(envelope);check(Buffer.byteLength(encoded)<=MAX_BACKUP,'backup_exceeds_limit');
 const parts=[];for(let offset=0;offset<encoded.length;offset+=CHUNK_BYTES)parts.push(encoded.slice(offset,offset+CHUNK_BYTES));
 const manifest={format:'waypoint-retained-backup-v1',backupId,sourceHash:envelope.sourceHash,keyFingerprint:envelope.keyFingerprint,encryptedSha256:sha256(encoded),bytes:Buffer.byteLength(encoded),chunks:parts.map((value,n)=>({key:'migration:'+backupId+':chunk:'+n,sha256:sha256(value)}))};
 return {parts,manifest};
}
export async function readRetainedBackup(api,namespace,manifest){
 check(manifest?.format==='waypoint-retained-backup-v1'&&Array.isArray(manifest.chunks)&&manifest.chunks.length>0&&manifest.chunks.length<=40,'invalid_backup_manifest');
 check(/^[a-f0-9]{32}$/i.test(namespace),'invalid_backup_namespace');
 const base='/storage/kv/namespaces/'+namespace,parts=[];let bytes=0;
 for(const chunk of manifest.chunks){
  check(chunk.key?.startsWith('migration:'+manifest.backupId+':chunk:')&&/^[a-f0-9]{64}$/.test(chunk.sha256),'invalid_backup_manifest');
  const part=await api.request(base+'/values/'+encodeURIComponent(chunk.key),{raw:true});bytes+=Buffer.byteLength(part);check(bytes<=MAX_BACKUP,'backup_exceeds_limit');check(sha256(part)===chunk.sha256,'backup_chunk_mismatch');parts.push(part);
 }
 const encoded=parts.join('');check(sha256(encoded)===manifest.encryptedSha256&&Buffer.byteLength(encoded)===manifest.bytes,'backup_readback_mismatch');
 let envelope;try{envelope=JSON.parse(encoded);}catch{throw new RehearsalError('invalid_backup');}
 check(envelope.sourceHash===manifest.sourceHash&&envelope.keyFingerprint===manifest.keyFingerprint,'backup_manifest_mismatch');return envelope;
}
export async function retainBackup(api,namespace,envelope,backupId){
 const {parts,manifest}=backupParts(envelope,backupId),base='/storage/kv/namespaces/'+namespace;
 for(const [n,part] of parts.entries())await api.request(base+'/values/'+encodeURIComponent(manifest.chunks[n].key),{method:'PUT',textBody:part});
 const manifestKey='migration:'+backupId+':manifest';
 await api.request(base+'/values/'+encodeURIComponent(manifestKey),{method:'PUT',textBody:JSON.stringify(manifest)});
 // A read-back verifies actual retained bytes; a write response alone is insufficient.
 const stored=JSON.parse(await api.request(base+'/values/'+encodeURIComponent(manifestKey),{raw:true}));
 check(canonical(stored)===canonical(manifest),'backup_manifest_mismatch');
 await readRetainedBackup(api,namespace,stored);return {...manifest,namespaceId:namespace,manifestKey};
}
