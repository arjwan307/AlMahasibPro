import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnterpriseLocal } from '../../apps/local/enterprise-server.js';

test('user administration enforces permissions, revokes access and persists edits', async()=>{
 const directory=await mkdtemp(join(tmpdir(),'users-test-'));let runtime;
 try{
  runtime=await startEnterpriseLocal({dataDirectory:directory,port:33221});
  async function request(path,body,method='POST',cookie=''){
   const response=await fetch(runtime.url+path,{headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{method,body:JSON.stringify(body)}:{})});
   return {status:response.status,data:response.status===204?null:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  await request('/api/local/setup',{legalName:'شركة اختبار',ownerName:'مدير',username:'owner',password:'Strong-Password-123'});
  const login=await request('/api/v1/auth/login',{companyCode:'local',username:'owner',password:'Strong-Password-123'});const ownerCookie=login.cookie;
  const loginRoles=await request('/api/v1/auth/roles?companyCode=local',null);assert.ok(loginRoles.data.roles.some(role=>role.code==='representative'));assert.equal(loginRoles.data.roles[0].permissions,undefined);
  const wrongRole=await request('/api/v1/auth/login',{companyCode:'local',username:'owner',password:'Strong-Password-123',roleCode:'representative'});assert.equal(wrongRole.status,403);assert.equal(wrongRole.cookie,undefined);
  const listing=await request('/api/v1/users',null,'GET',ownerCookie);assert.equal(listing.status,200);const owner=listing.data.users[0];assert.equal(owner.passwordHash,undefined);
  assert.ok(listing.data.roles.some(role=>role.code==='accountant'));
  const roleBody={name:'مسؤول التجهيز',permissions:['catalog.read','inventory.read']};
  const roleCreated=await request('/api/v1/roles',roleBody,'POST',ownerCookie);assert.equal(roleCreated.status,201);
  const customCode=roleCreated.data.role.code;
  assert.equal((await request('/api/v1/roles',roleBody,'POST',ownerCookie)).status,409);
  assert.equal((await request('/api/v1/roles',{name:'غير مسموح',permissions:['company.approve']},'POST',ownerCookie)).status,400);
  const supplyCreated=await request('/api/v1/users',{username:'supply',displayName:'مسؤول',password:'Strong-Supply-123',roleCode:customCode},'POST',ownerCookie);assert.equal(supplyCreated.status,201);
  const supplyLogin=await request('/api/v1/auth/login',{companyCode:'local',username:'supply',password:'Strong-Supply-123'});
  assert.deepEqual((await request('/api/v1/bootstrap',null,'GET',supplyLogin.cookie)).data.permissions,roleBody.permissions);
  assert.equal((await request('/api/v1/roles',{name:'محظور',permissions:[]},'POST',supplyLogin.cookie)).status,403);
  const body={username:'حسن كاظم',displayName:'مندوب',password:'Strong-Seller-123',roleCode:'representative',permissions:['catalog.read','sync.use']};
  const created=await request('/api/v1/users',body,'POST',ownerCookie);assert.equal(created.status,201);const id=created.data.user.id;
  const sellerLogin=await request('/api/v1/auth/login',{companyCode:'local',username:'حسن كاظم',password:body.password,roleCode:'representative'});const sellerCookie=sellerLogin.cookie;
  const ownerSecondLogin=await request('/api/v1/auth/login',{companyCode:'local',username:'owner',password:'Strong-Password-123'});
  for(const cookie of [ownerCookie,ownerSecondLogin.cookie,supplyLogin.cookie,sellerCookie])assert.equal((await request('/api/v1/presence/heartbeat',{},'POST',cookie)).status,204);
  const online=(await request('/api/v1/presence/online-users',null,'GET',ownerCookie));assert.equal(online.status,200);assert.equal(online.data.count,3);assert.equal(online.data.userIds.length,3);assert.ok(online.data.userIds.includes(owner.id));assert.ok(online.data.userIds.includes(supplyCreated.data.user.id));assert.ok(online.data.userIds.includes(id));assert.equal(online.data.windowSeconds,90);
  assert.equal((await request('/api/v1/presence/online-users',null,'GET',supplyLogin.cookie)).status,403);
  assert.equal((await request('/api/v1/users',null,'GET',sellerCookie)).status,403);
  assert.equal((await request('/api/v1/users/'+id,{...body,status:'active'},'PUT',sellerCookie)).status,403);
  assert.equal((await request('/api/v1/bootstrap',null,'GET',sellerCookie)).data.permissions.includes('sales.create'),false);
  assert.equal((await request('/api/v1/users/'+owner.id,{username:'owner',displayName:'مدير',roleCode:'company_admin',status:'disabled'},'PUT',ownerCookie)).status,409);
  assert.equal((await request('/api/v1/users/'+id,{...body,status:'active',permissions:['company.approve']},'PUT',ownerCookie)).status,400);
  assert.equal((await request('/api/v1/users/'+crypto.randomUUID(),{...body,status:'active'},'PUT',ownerCookie)).status,404);
  const updated=await request('/api/v1/users/'+id,{...body,displayName:'الاسم الجديد',password:'Changed-Seller-123',status:'disabled'},'PUT',ownerCookie);assert.equal(updated.status,200);
  assert.equal((await request('/api/v1/presence/online-users',null,'GET',ownerCookie)).data.count,2);
  assert.equal((await request('/api/v1/bootstrap',null,'GET',sellerCookie)).status,401);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:'حسن كاظم',password:'Changed-Seller-123'})).status,403);
  await runtime.close();runtime=await startEnterpriseLocal({dataDirectory:directory,port:33221});
  assert.ok((await request('/api/v1/roles',null,'GET',ownerCookie)).data.roles.some(role=>role.code===customCode));
  const stored=(await request('/api/v1/users',null,'GET',ownerCookie)).data.users.find(row=>row.id===id);assert.equal(stored.status,'disabled');assert.equal(stored.displayName,'الاسم الجديد');assert.deepEqual(stored.permissions,body.permissions);
  assert.equal((await request('/api/v1/users/'+id,{...body,password:'',status:'active'},'PUT',ownerCookie)).status,200);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:'حسن كاظم',password:'Changed-Seller-123'})).status,200);
 }finally{if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
