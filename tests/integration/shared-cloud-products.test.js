import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnterpriseCloud } from '../../apps/api/src/cloud-server.js';
test('shared cloud separates product databases, cookies, pages and browser storage',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'shared-cloud-'));let runtime;const setupToken='test-setup-key-longer-than-24-characters';
 try{
  runtime=await startEnterpriseCloud({dataDirectory:directory,setupToken,origin:'http://localhost',port:0});
  async function request(path,body,cookie=''){const response=await fetch(runtime.url+path,{headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:response.status,data:response.status===204?{}:await response.json(),cookie:response.headers.get('set-cookie')};}
  for(const prefix of ['', '/retail'])assert.equal((await request(prefix+'/api/local/setup',{setupToken,legalName:prefix?'مطعم':'شركة',ownerName:'مدير',username:'owner',password:'Strong-Password-123'})).status,201);
  const body={companyCode:'company',username:'owner',password:'Strong-Password-123'};
  const company=await request('/api/v1/auth/login',body),retail=await request('/retail/api/v1/auth/login',body);
  assert.match(company.cookie,/^almahasib_session=/);assert.match(retail.cookie,/^almahasib_retail_session=/);assert.match(retail.cookie,/Path=\/retail\//);
  const companyCookie=company.cookie.split(';')[0],retailCookie=retail.cookie.split(';')[0];
  assert.equal((await request('/api/v1/bootstrap',null,retailCookie)).status,401);
  assert.equal((await request('/retail/api/v1/bootstrap',null,companyCookie)).status,401);
  assert.equal((await request('/retail/api/v1/bootstrap',null,'almahasib_retail_session='+company.data.token)).status,401);
  assert.notEqual(company.data.account.company.id,retail.data.account.company.id);
  assert.equal((await request('/api/v1/bootstrap',null,companyCookie+'; '+retailCookie)).data.company.legalName,'شركة');
  assert.equal((await request('/retail/api/v1/bootstrap',null,companyCookie+'; '+retailCookie)).data.company.legalName,'مطعم');
  assert.equal((await fetch(runtime.url+'/retail/enterprise.html')).status,404);
  assert.equal((await fetch(runtime.url+'/retail/representative.html')).status,404);
  assert.equal((await fetch(runtime.url+'/pos.html')).status,404);
  const html=await (await fetch(runtime.url+'/retail/retail-login.html')).text();assert.ok(html.includes('/retail/retail-login.js'));assert.ok(html.includes('/retail/retail-scope.js'));
  for(const file of ['retail-login.js','retail-scope.js','pos-ui.js','market-offline.js','restaurant-pos.js','offline-sync.js']){const response=await fetch(runtime.url+'/retail/'+file);assert.equal(response.status,200);new Script(await response.text(),{filename:file});}
  const script=await (await fetch(runtime.url+'/retail/retail-login.js')).text();assert.ok(script.includes('/retail/api/v1/auth/login'));
  assert.equal((await request('/retail/api/v1/auth/logout',{},retailCookie)).status,204);
  assert.equal((await request('/api/v1/bootstrap',null,companyCookie)).status,200);
  await runtime.close();runtime=await startEnterpriseCloud({dataDirectory:directory,setupToken,origin:'http://localhost',port:0});
  assert.equal((await request('/api/local/status')).data.initialized,true);assert.equal((await request('/retail/api/local/status')).data.initialized,true);
 }finally{if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
