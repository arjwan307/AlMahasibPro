import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnterpriseLocal } from '../../apps/local/enterprise-server.js';
test('company and retail runtimes expose separate pages and keep separate databases', async()=>{
 const directory=await mkdtemp(join(tmpdir(),'products-'));let company,retail;
 try{
  company=await startEnterpriseLocal({dataDirectory:join(directory,'company'),port:13225});
  retail=await startEnterpriseLocal({dataDirectory:join(directory,'retail'),port:13226,product:'retail'});
  assert.equal((await fetch(company.url+'/market-cashier.html')).status,404);
  assert.equal((await fetch(company.url+'/pos.html')).status,404);
  assert.equal((await fetch(company.url+'/dashboard.html',{redirect:'manual'})).headers.get('location'),'/enterprise.html');
  assert.equal((await fetch(retail.url+'/enterprise.html')).status,404);
  assert.equal((await fetch(retail.url+'/representative.html')).status,404);
  assert.equal((await fetch(retail.url+'/dashboard.html',{redirect:'manual'})).headers.get('location'),'/retail.html');
  assert.equal((await fetch(retail.url+'/pos.html')).status,200);
  assert.equal((await fetch(retail.url+'/market-cashier.html')).status,200);
  assert.equal((await fetch(company.url+'/api/v1/market/snapshot')).status,404);
  assert.equal((await fetch(retail.url+'/api/v1/payroll/cycles')).status,404);
  for(const asset of ['enterprise-sections.css','enterprise-workspaces.css']){assert.equal((await fetch(company.url+'/'+asset)).status,200);assert.equal((await fetch(retail.url+'/'+asset)).status,404);}
  assert.equal((await fetch(company.url+'/settings.html')).status,200);
  assert.equal((await fetch(retail.url+'/settings.html')).status,200);
  const setup=await fetch(company.url+'/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({legalName:'شركة',ownerName:'مدير',username:'owner',password:'Strong-Password-123'})});assert.equal(setup.status,201);
  assert.equal((await (await fetch(retail.url+'/api/local/status')).json()).initialized,false);
 }finally{if(company)await company.close();if(retail)await retail.close();await rm(directory,{recursive:true,force:true});}
});
