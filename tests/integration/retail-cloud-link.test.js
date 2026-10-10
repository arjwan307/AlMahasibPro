import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {startEnterpriseCloud} from '../../apps/api/src/cloud-server.js';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';

test('unified local device can adopt the retail cloud through its /retail API base',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'almahasib-retail-link-')),setupToken='retail-link-setup-token-longer-than-24';
 const cloud=await startEnterpriseCloud({dataDirectory:join(dir,'cloud'),setupToken,origin:'http://localhost',port:0});let local;t.after(async()=>{await local?.close();await cloud.close();});
 const password='Retail-Offline-Password';
 const setup=await fetch(cloud.url+'/retail/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupToken,legalName:'Retail link',ownerName:'Owner',username:'owner',password})});assert.equal(setup.status,201);
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 local=await startEnterpriseLocal({dataDirectory:join(dir,'local'),port,product:'unified',allowTestCloud:true,protect:bytes=>bytes,unprotect:bytes=>bytes});
 const response=await fetch(local.url+'/api/local/cloud/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:cloud.url+'/retail',companyCode:'retail',username:'owner',password,adopt:true})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.companyCode,'retail');
 const login=await fetch(local.url+'/retail/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:'retail',username:'owner',password})});assert.equal(login.status,200);
 assert.equal([...local.store.companies.values()][0].legalName,'Retail link');
});
