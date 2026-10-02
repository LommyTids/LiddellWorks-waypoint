#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Cloudflare,RehearsalError,check } from './cloudflare.mjs';
import { decryptBackup,readRetainedBackup } from './migration-backup.mjs';
import { buildImport } from './plan-import.mjs';
try{
 const [command,...args]=process.argv.slice(2);
 if(command==='generate-keys'){
  check(args.length===1,'invalid_arguments');const dir=args[0];await mkdir(dir,{mode:0o700});
  const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  await writeFile(join(dir,'private.pem'),keys.privateKey,{mode:0o600,flag:'wx'});await writeFile(join(dir,'public.pem'),keys.publicKey,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'keys_created',nextStep:'Keep private.pem locally. Copy public.pem into the WAYPOINT_BACKUP_PUBLIC_KEY GitHub environment variable. Never upload private.pem.'}));
 }else if(command==='download'){
  const [namespace,manifestKey,output]=args;check(args.length===3&&/^[a-f0-9]{32}$/i.test(namespace)&&/^migration:[a-z0-9-]+:manifest$/.test(manifestKey),'invalid_arguments');
  const api=new Cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID,process.env.CLOUDFLARE_API_TOKEN);
  const manifest=JSON.parse(await api.request('/storage/kv/namespaces/'+namespace+'/values/'+encodeURIComponent(manifestKey),{raw:true}));
  const envelope=await readRetainedBackup(api,namespace,manifest);await writeFile(output,JSON.stringify(envelope)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({status:'backup_downloaded',sourceHash:manifest.sourceHash,encryptedSha256:manifest.encryptedSha256}));
 }else if(command==='decrypt'){
  const [input,keyFile,output]=args;check(args.length===3,'invalid_arguments');
  const snapshot=decryptBackup(JSON.parse(await readFile(input,'utf8')),await readFile(keyFile,'utf8'));const plan=buildImport(snapshot);
  await writeFile(output,JSON.stringify(snapshot)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({status:'backup_recovery_verified',sourceHash:plan.sourceHash,counts:plan.counts}));
 }else throw new RehearsalError('invalid_command');
}catch(error){console.error(JSON.stringify({status:'failed',code:error instanceof RehearsalError?error.code:'backup_tool_failed'}));process.exitCode=1;}
