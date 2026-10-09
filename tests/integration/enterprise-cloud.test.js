import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnterpriseCloud } from '../../apps/api/src/cloud-server.js';

test('cloud setup, manager and representative access persist securely after restart', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'cloud-test-'));
 const setupToken = 'test-only-setup-token-at-least-24-characters';
 const origin = 'https://company.example';
 let runtime;
 try {
  const start = () => startEnterpriseCloud({dataDirectory:directory,setupToken,origin,port:0});
  runtime = await start();
  async function request(path, body, cookie='', extraHeaders={}) {
   const response = await fetch(runtime.url+path,{headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,...extraHeaders},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
   return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  assert.equal((await request('/api/health')).data.storage,'sqlite');
  const selector=await fetch(runtime.url+'/');
  assert.equal(selector.url,runtime.url+'/');
  assert.equal(selector.status,200);
  assert.match(await selector.text(),/اختيار التطبيق/);
  assert.equal((await request('/api/v1/companies/register',{})).status,400);
  const owner={legalName:'شركة اختبار',ownerName:'مدير',username:'owner',password:'Strong-Password-123',setupToken};
  assert.equal((await request('/api/local/setup',{...owner,setupToken:'wrong'})).status,403);
  assert.equal((await request('/api/local/setup',owner,'',{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await request('/api/local/setup',owner)).status,201);
  assert.equal((await request('/api/local/setup',owner)).status,409);
  const admin=await request('/api/v1/auth/login',{companyCode:'company',username:'owner',password:owner.password});
  assert.equal(admin.status,200);assert.match(admin.cookie,/Secure/);assert.match(admin.cookie,/HttpOnly/);
  const adminCookie=admin.cookie.split(';')[0];
  const seller={displayName:'مندوب اختبار',username:'seller',roleCode:'representative',password:'Strong-Seller-123'};
  assert.equal((await request('/api/v1/users',seller,adminCookie)).status,201);
  const login=await request('/api/v1/auth/login',{companyCode:'company',username:'seller',password:seller.password});
  assert.equal(login.status,200);
  const sellerCookie=login.cookie.split(';')[0];
  assert.equal((await request('/api/v1/users',null,sellerCookie)).status,403);
  assert.equal((await request('/api/v1/bootstrap',null,sellerCookie)).data.permissions.includes('sales.create'),true);
  await runtime.close();runtime=await start();
  assert.equal((await request('/api/local/status')).data.setupRequired,false);
  assert.equal((await request('/api/v1/bootstrap',null,sellerCookie)).status,200);
  assert.equal((await request('/api/v1/users',null,adminCookie)).data.users.length,2);
 } finally {if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
