import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';

test('treasury checkboxes persist and authorize cash operations without granting general journal posting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'treasury-permissions-'));let runtime,cookie='';
 try{
  runtime=await startEnterpriseLocal({dataDirectory:dir,port:33229});
  const request=async(path,body)=>{const r=await fetch(runtime.url+path,{headers:{Connection:'close',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
  const password='Treasury-Strong-123';
  assert.equal((await request('/api/local/setup',{legalName:'معزول',ownerName:'Owner',username:'treasury_owner',password})).status,201);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:'treasury_owner',password})).status,200);
  const users=await request('/api/v1/users');assert.ok(users.data.permissions.includes('treasury.read'));assert.ok(users.data.permissions.includes('treasury.manage'));
  const branch=(await request('/api/v1/company/branches')).data.branches[0];
  for(const [username,permissions] of [['treasury_operator',['treasury.read','treasury.manage']],['treasury_reader',['treasury.read']]])assert.equal((await request('/api/v1/users',{username,displayName:username,password,roleCode:'cashier',permissions})).status,201);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:'treasury_operator',password})).status,200);
  assert.equal((await request('/api/v1/treasury/accounts')).status,200);
  const created=await request('/api/v1/treasury/cashboxes',{code:'PERM',name:'صندوق',currency:'IQD',branchId:branch.id});assert.equal(created.status,201,JSON.stringify(created.data));
  const box=created.data.cashbox;
  assert.equal((await request('/api/v1/treasury/cashboxes/'+box.id+'/open',{operationId:crypto.randomUUID(),sessionNumber:'P1',openingBalance:'0'})).status,201);
  assert.equal((await request('/api/v1/treasury/cashboxes/'+box.id+'/movements',{operationId:crypto.randomUUID(),movementNumber:'M1',direction:'in',amount:'5',counterAccountCode:'3000-EQUITY'})).status,201);
  assert.equal((await request('/api/v1/accounting/journals',{operationId:crypto.randomUUID(),entryNumber:'DENIED',occurredAt:new Date().toISOString(),lines:[]})).status,403);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:'treasury_reader',password})).status,200);
  assert.equal((await request('/api/v1/treasury/cashboxes')).status,200);
  assert.equal((await request('/api/v1/treasury/closures')).status,200);
  assert.equal((await request('/api/v1/treasury/cashboxes/'+box.id+'/movements')).status,200);
  assert.equal((await request('/api/v1/treasury/cashboxes',{code:'DENY',name:'Denied',currency:'IQD',branchId:branch.id})).status,403);
 }finally{await runtime?.close();await rm(dir,{recursive:true,force:true});}
});
