import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';

test('LAN sharing requires explicit HTTPS configuration before opening the database',async()=>{
 await assert.rejects(()=>startEnterpriseLocal({dataDirectory:'unused-test-directory',bindHost:'0.0.0.0'}),/HTTPS/);
});

test('unified desktop serves both business interfaces and their shared source assets',async t=>{
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const directory=await mkdtemp(join(tmpdir(),'mahasib-unified-')),runtime=await startEnterpriseLocal({dataDirectory:directory,port,product:'unified'});t.after(()=>runtime.close());
 const start=await(await fetch(runtime.url+'/')).text();assert(start.includes('href="/retail-login.html"'));assert(start.includes('href="/enterprise.html"'));assert(!start.includes('href="/retail/retail-login.html"'));
 assert.equal((await fetch(runtime.url+'/retail/api/local/status')).status,200);
 for(const file of ['enterprise.html','retail-login.html','pos.html','market-cashier.html','company-output.css','company-sync-ui.js','restaurant-pos.js'])assert.equal((await fetch(runtime.url+'/'+file)).status,200,file);
 const response=await fetch(runtime.url+'/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({legalName:'Local unified',ownerName:'Owner',username:'owner',password:'offline-password'})});assert.equal(response.status,201);
 const login=await fetch(runtime.url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:'local',username:'owner',password:'offline-password'})});assert.equal(login.status,200);
 const token=(await login.json()).token;const bootstrap=await fetch(runtime.url+'/api/v1/bootstrap',{headers:{Authorization:'Bearer '+token}});assert.equal(bootstrap.status,200);assert.equal((await bootstrap.json()).company.legalName,'Local unified');
});
test('retail serves ERP offline assets and allows reaching local SQLite without internet',async t=>{
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const directory=await mkdtemp(join(tmpdir(),'mahasib-erp-runtime-')),runtime=await startEnterpriseLocal({dataDirectory:directory,port,product:'retail'});t.after(()=>runtime.close());
 const status=await fetch(runtime.url+'/api/local/status');assert.equal((await status.json()).local,true);
 assert.equal((await fetch(runtime.url+'/api/local/status',{headers:{Origin:'https://untrusted.invalid'}})).status,403);
 for(const file of ['erp-offline.js','erp-service-worker.js','erp-shell-manifest.js'])assert.equal((await fetch(runtime.url+'/'+file)).status,200);
 const cashier=await (await fetch(runtime.url+'/market-cashier.html')).text();assert(cashier.includes('window.AlMahasibLocalMode=true'));assert(cashier.includes('/erp-offline.js'));assert(!cashier.includes("register('/market-service-worker.js')"));
 const script=await(await fetch(runtime.url+'/market-offline.js')).text();assert(script.includes('(window.AlMahasibLocalMode || navigator.onLine)'));assert(!script.includes('!window.AlMahasibLocalMode && navigator.onLine'));
});
