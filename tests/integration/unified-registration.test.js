import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startEnterpriseCloud } from '../../apps/api/src/cloud-server.js';
import { startEnterpriseLocal } from '../../apps/local/enterprise-server.js';

test('three desktop signup requests reach the cloud as separate business types and approved identities work offline', async () => {
 const directory=await mkdtemp(join(tmpdir(),'unified-signup-'));
 let cloud,local;
 try {
  cloud=await startEnterpriseCloud({dataDirectory:join(directory,'cloud'),origin:'http://localhost',port:0});
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  local=await startEnterpriseLocal({dataDirectory:join(directory,'local'),port,product:'unified',allowTestCloud:true,cloudOrigin:cloud.url,protect:bytes=>bytes,unprotect:bytes=>bytes});
  const password='New-Customer-Password-2026';
  async function post(base,path,body){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
  const customers=[];
  for(const businessType of ['company','restaurant','complex']) {
   const result=await post(local.url,'/api/v1/companies/register',{businessType,legalName:businessType,ownerName:'Owner',phone:'07000000000',username:'owner',password});
   assert.equal(result.status,201,JSON.stringify(result.data));
   assert.equal(result.data.company.businessType,businessType);
   assert.equal(result.data.company.status,'pending');
   assert.equal(local.store.companies.size,0);
   customers.push(result.data.company);
  }
  assert.equal((await cloud.store.listPendingCompanies()).length,3);
  for(let index=0;index<customers.length;index++) {
   const customer=customers[index],companyCode=['company2020','retail50','mark75'][index];
   assert.notEqual((await post(cloud.url,'/api/v1/auth/login',{companyCode:customer.code,username:'owner',password})).status,200);
   await cloud.store.approveCompany(customer.id,'test-developer',companyCode);
   const result=await post(cloud.url,'/api/v1/auth/login',{companyCode,username:'owner',password});
   assert.equal(result.status,200);
   assert.equal(result.data.account.company.id,customer.id);
  }
  const localLogin=await post(local.url,'/api/v1/auth/login',{companyCode:'company2020',username:'owner',password});
  assert.equal(localLogin.status,200,JSON.stringify(localLogin.data));
  assert.equal(localLogin.data.account.company.id,customers[0].id);
  await cloud.close();cloud=null;
  const offline=await post(local.url,'/api/v1/auth/login',{companyCode:'company2020',username:'owner',password});
  assert.equal(offline.status,200);
  assert.equal(offline.data.account.company.id,customers[0].id);
  const failed=await post(local.url,'/api/v1/companies/register',{businessType:'company',legalName:'Unsent',ownerName:'Owner',phone:'07000000000',username:'owner',password});
  assert.equal(failed.status,503);
  assert.equal(local.store.companies.size,1);
 } finally {await local?.close();await cloud?.close();await rm(directory,{recursive:true,force:true});}
});
