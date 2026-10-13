import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteStore } from '../../apps/api/src/store/sqlite-store.js';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/lib/security.js';
import { startEnterpriseLocal } from '../../apps/local/enterprise-server.js';
import { commandPathAllowed } from '../../apps/api/src/lib/desktop-sync.js';
const password='Settings-Strong-123';
async function company(store,code){const row=await store.registerCompany({code,legalName:code,timezone:'Asia/Baghdad',currency:'IQD',owner:{username:'owner',displayName:'Owner',passwordHash:await hashPassword(password)}});await store.approveCompany(row.id,row.ownerUserId,code);return store.companies.get(row.id);}
// These ephemeral HTTP fixtures do not test connection reuse. Close each socket
// so CPU-heavy password/backup work cannot race Windows keep-alive expiry.
async function fixture(callback){const dir=await mkdtemp(join(tmpdir(),'settings-isolation-'));const store=new SQLiteStore(join(dir,'state.sqlite'));let server;try{const a=await company(store,'co901'),b=await company(store,'co902');const app=createApp({store});server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});const base='http://127.0.0.1:'+server.address().port;const request=async(path,body,token,method=body?'POST':'GET')=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Connection:'close',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};const login=await request('/api/v1/auth/login',{companyCode:a.code,username:'owner',password});await callback({store,dir,a,b,request,token:login.data.token});}finally{if(server)await new Promise(r=>server.close(r));await store.close();await rm(dir,{recursive:true,force:true});}}
const confirmation=(a,kind='company')=>({confirm:true,confirmation:(kind==='local'?'ERASE LOCAL ':'DELETE COMPANY ')+a.code,password,reason:'integration test'});
test('settings profile and company edits derive identity from session, ignoring foreign IDs',()=>fixture(async({store,a,b,request,token})=>{
 const response=await request('/api/v1/settings/profile',{displayName:'New Name',companyId:b.id,userId:b.ownerUserId},token,'PATCH');assert.equal(response.status,200);assert.equal(store.users.get(a.ownerUserId).displayName,'New Name');assert.equal(store.users.get(b.ownerUserId).displayName,'Owner');
 const edit=await request('/api/v1/settings/company',{legalName:'Updated',phone:'0770',address:'Baghdad',companyId:b.id},token,'PATCH');assert.equal(edit.status,200);assert.equal(store.companies.get(a.id).legalName,'Updated');assert.equal(store.companies.get(b.id).legalName,b.code);
}));
test('destructive permission, exact confirmation and password are mandatory; backup failure aborts purge',()=>fixture(async({store,a,b,request,token})=>{
 assert.equal((await request('/api/v1/settings/delete-company',confirmation(a),token)).status,403);
 await store.transaction(()=>{store.users.get(a.ownerUserId).permissions=['company.manage','company.delete'];});
 assert.equal((await request('/api/v1/settings/delete-company',{...confirmation(a),confirmation:'DELETE COMPANY '+b.code},token)).status,400);
 assert.equal((await request('/api/v1/settings/delete-company',{...confirmation(a),password:'wrong'},token)).status,403);
 const original=store.exportCompanyBackup;store.exportCompanyBackup=async()=>{throw Error('simulated backup failure');};
 assert.equal((await request('/api/v1/settings/delete-company',confirmation(a),token)).status,500);store.exportCompanyBackup=original;
 assert.ok(store.companies.has(a.id));assert.ok(store.companies.has(b.id));
}));
test('cloud deletion backs up only A, audits outside purged scope, revokes sessions and blocks old snapshots',()=>fixture(async({store,dir,a,b,request,token})=>{
 await store.transaction(()=>{store.users.get(a.ownerUserId).permissions=['company.delete'];});const old=await store.exportCompanyBackup(a.id);
 const response=await request('/api/v1/settings/delete-company',{...confirmation(a),companyId:b.id},token);assert.equal(response.status,200);assert.equal(store.companies.has(a.id),false);assert.equal(store.companies.has(b.id),true);assert.equal((await request('/api/v1/settings',null,token)).status,401);
 assert.ok(store.audit.some(x=>x.action==='settings.company.deleted'&&x.entityId===a.id&&x.metadata.backupId===response.data.backupId));
 const backup=new SQLiteStore(join(dir,'deletion-backups',response.data.backupId+'.sqlite'));try{assert.equal(backup.companies.size,1);assert.ok(backup.companies.has(a.id));assert.equal(backup.sessions.size,0);}finally{await backup.close();}
 await assert.rejects(store.importCloudSnapshot(old,a.id,{initial:true}));
}));
test('account deletion anonymizes only own identity; owner must transfer ownership',()=>fixture(async({store,a,b,request,token})=>{
 await store.transaction(()=>store.users.get(a.ownerUserId).permissions=['account.delete','users.manage']);
 assert.equal((await request('/api/v1/settings/delete-account',{confirm:true,confirmation:'DELETE ACCOUNT owner',password,reason:'test'},token)).status,409);
 const user=await store.createUser(a.id,{username:'member',displayName:'Member',passwordHash:await hashPassword(password),roleCode:'cashier',permissions:['account.delete'],scopes:[]},a.ownerUserId);
 const login=await request('/api/v1/auth/login',{companyCode:a.code,username:'member',password});
 const oldSnapshot=await store.exportCompanyBackup(a.id);
 const result=await request('/api/v1/settings/delete-account',{confirm:true,confirmation:'DELETE ACCOUNT member',password,reason:'test'},login.data.token);assert.equal(result.status,200);assert.equal(result.data.companyDeleted,false);assert.equal(store.users.get(user.id).status,'disabled');assert.equal(store.users.get(user.id).passwordHash,'');assert.ok(store.companies.has(a.id));assert.ok(store.companies.has(b.id));assert.equal((await request('/api/v1/settings',null,login.data.token)).status,401);
 assert.equal(await store.importCloudSnapshot(oldSnapshot,a.id),true);assert.equal(store.users.get(user.id).passwordHash,'');assert.equal(store.users.get(user.id).status,'disabled');assert.ok(store.deletedAccounts.has(user.id));
}));
test('company snapshot import preserves B, B sessions, B outbox and unrelated tombstones',()=>fixture(async({store,a,b})=>{
 const snapshot=await store.exportCompanyBackup(a.id);await store.transaction(()=>{store.desktopCommands.set('b-pending',{companyId:b.id,local:true,status:'pending'});store.deletedCompanies.set('historic',{companyId:'historic',code:'historic',generation:1});});
 await store.createSession({tokenHash:'b-session',userId:b.ownerUserId,deviceId:'b',expiresAt:new Date(Date.now()+10000).toISOString()});
 assert.equal(await store.importCloudSnapshot(snapshot,a.id,{initial:true}),true);assert.ok(store.companies.has(b.id));assert.ok(store.users.has(b.ownerUserId));assert.ok(store.sessions.has('b-session'));assert.ok(store.desktopCommands.has('b-pending'));assert.ok(store.deletedCompanies.has('historic'));
 await store.transaction(()=>store.desktopCommands.set('a-pending',{companyId:a.id,local:true,status:'pending'}));assert.equal(await store.importCloudSnapshot(snapshot,a.id,{initial:true}),false);
}));
test('local company erase preserves other tenants and persists a local-only barrier after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'local-erase-'));let runtime;
 try{runtime=await startEnterpriseLocal({dataDirectory:dir,port:33317});const a=await company(runtime.store,'co911'),b=await company(runtime.store,'co912');await runtime.store.transaction(()=>runtime.store.users.get(a.ownerUserId).permissions=['local.data.delete']);
 const response=await fetch(runtime.url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:a.code,username:'owner',password})});const login=await response.json();
 const erased=await fetch(runtime.url+'/api/local/settings/erase-company',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({...confirmation(a,'local'),companyId:b.id})});assert.equal(erased.status,200);assert.equal((await erased.json()).cloudDeleted,false);assert.ok(runtime.store.companies.has(b.id));assert.equal(runtime.store.companies.has(a.id),false);assert.equal(runtime.store.deletedCompanies.get(a.id).localOnly,true);
 await runtime.close();runtime=null;const restarted=new SQLiteStore(join(dir,'enterprise.sqlite'));try{assert.ok(restarted.companies.has(b.id));assert.equal(restarted.deletedCompanies.get(a.id).localOnly,true);}finally{await restarted.close();}
 const config=JSON.parse(await readFile(join(dir,'cloud-connection.json'),'utf8').catch(()=>'{"config":{"automatic":false}}'));assert.equal(config.config.automatic,false);
 }finally{if(runtime)await runtime.close();await rm(dir,{recursive:true,force:true});}
});
test('destructive settings and secrets cannot enter desktop replay queue',()=>{
 for(const route of ['delete-account','delete-company'])assert.equal(commandPathAllowed('/api/v1/settings/'+route),false);
 assert.equal(commandPathAllowed('/api/v1/settings/profile'),true);assert.equal(commandPathAllowed('/api/v1/settings/company'),true);
});

test('linked cloud deletion rejects pending edits, survives lost acknowledgement and never replays the deleted tenant',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloud-delete-retry-'));const cloud=new SQLiteStore(join(dir,'cloud.sqlite'));let server,local;
 try {
  const a=await company(cloud,'co921'),b=await company(cloud,'co922');
  await cloud.transaction(()=>{cloud.users.get(a.ownerUserId).permissions=['company.manage','company.delete','sync.use','catalog.manage'];});
  server=await new Promise(resolve=>{const s=createApp({store:cloud}).listen(0,'127.0.0.1',()=>resolve(s));});const cloudUrl='http://127.0.0.1:'+server.address().port;
  local=await startEnterpriseLocal({dataDirectory:join(dir,'local'),port:33318,allowTestCloud:true,cloudOrigin:cloudUrl,protect:x=>x,unprotect:x=>x});let token;
  const request=async(path,body)=>{const r=await fetch(local.url+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  assert.equal((await request('/api/local/cloud/connect',{url:cloudUrl,companyCode:a.code,username:'owner',password,adopt:true})).status,200);
  token=(await request('/api/v1/auth/login',{companyCode:a.code,username:'owner',password})).data.token;
  // This scenario deliberately keeps an offline command pending for deletion review.
  await fetch(local.url+'/api/local/cloud/settings',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({automatic:false})});
  assert.equal((await request('/api/v1/catalog/units',{code:'PENDING',name:'pending'})).status,201);
  assert.equal((await request('/api/local/settings/delete-cloud-company',confirmation(a))).status,400);assert.ok(cloud.companies.has(a.id));
  assert.equal((await request('/api/local/cloud/synchronize',{})).data.state,'complete');
  const original=globalThis.fetch;globalThis.fetch=async(input,options)=>{const r=await original(input,options);if(String(input)===cloudUrl+'/api/v1/settings/delete-company'){await r.text();throw Error('lost acknowledgement');}return r;};
  try{assert.equal((await request('/api/local/settings/delete-cloud-company',confirmation(a))).status,400);}finally{globalThis.fetch=original;}
  assert.equal(cloud.companies.has(a.id),false);assert.equal(local.store.companies.has(a.id),true);
  assert.equal((await request('/api/local/cloud/synchronize',{})).data.state,'deleted');assert.equal(local.store.companies.has(a.id),false);assert.ok(local.store.deletedCompanies.has(a.id));assert.ok(cloud.companies.has(b.id));
  const config=JSON.parse(await readFile(join(dir,'local','cloud-connection.json'),'utf8'));assert.equal(config.config.automatic,false);assert.equal(config.config.companyId,undefined);
 }finally{await local?.close();if(server)await new Promise(r=>server.close(r));await cloud.close();await rm(dir,{recursive:true,force:true});}
});

test('a branch-scoped destructive grant cannot delete the whole company',()=>fixture(async({store,a,request,token})=>{
 await store.transaction(()=>{Object.assign(store.users.get(a.ownerUserId),{permissions:['company.delete'],scopes:[{type:'branch',id:a.branches[0].id}]});});
 assert.equal((await request('/api/v1/settings/delete-company',confirmation(a),token)).status,403);assert.ok(store.companies.has(a.id));
}));

test('ownership transfer stays inside the tenant, survives old snapshots and lets the former owner delete only their account',()=>fixture(async({store,a,b,request,token})=>{
 const manager=await store.createUser(a.id,{username:'new-owner',displayName:'New Owner',passwordHash:await hashPassword(password),roleCode:'company_admin',scopes:[]},a.ownerUserId);
 const old=await store.exportCompanyBackup(a.id);
 const body={confirm:true,confirmation:'TRANSFER OWNER '+a.code,password,reason:'owner leaving',newOwnerId:b.ownerUserId};
 assert.equal((await request('/api/v1/settings/transfer-owner',body,token)).status,400);
 assert.equal((await request('/api/v1/settings/transfer-owner',{...body,newOwnerId:manager.id},token)).status,200);
 assert.equal(store.companies.get(a.id).ownerUserId,manager.id);
 await store.importCloudSnapshot(old,a.id);assert.equal(store.companies.get(a.id).ownerUserId,manager.id);
 await store.transaction(()=>store.users.get(a.ownerUserId).permissions=['account.delete']);
 assert.equal((await request('/api/v1/settings/delete-account',{confirm:true,confirmation:'DELETE ACCOUNT owner',password,reason:'leaving'},token)).status,200);
 assert.ok(store.companies.has(a.id));assert.equal(store.companies.get(a.id).ownerUserId,manager.id);assert.ok(store.companies.has(b.id));
}));
