import {createRequire} from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import express from 'express';
import {productPages} from '../../apps/api/src/product-pages.js';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {PERMISSIONS} from '../../apps/api/src/permissions.js';
const require=createRequire(process.env.PLAYWRIGHT_MODULE_PATH || new URL('../../package.json',import.meta.url)),{chromium}=require('playwright');
fs.mkdirSync('outputs',{recursive:true});
const store=new MemoryStore(),company=await store.registerCompany({code:'offline-test',legalName:'شركة اختبار الجهاز',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'admin',displayName:'مدير',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
const user=store.users.get(company.ownerUserId),auth={company,user,permissions:PERMISSIONS,roles:[],scopes:[],session:{deviceId:'test',expiresAt:new Date(Date.now()+86400000).toISOString()}};store.getSessionContext=async()=>auth;
const unit=await store.createUnit(company.id,{code:'PC',name:'قطعة',decimalPlaces:6},user.id),item=await store.createItem(company.id,{sku:'ITEM-1',name:'صنف الجهاز',baseUnitId:unit.id},user.id),warehouse=await store.createWarehouse(company.id,{code:'MAIN',name:'مخزن الجهاز',kind:'standard'},user.id);
const origins=[];const web=express();web.get(['/', '/index.html'],(_req,res)=>res.redirect('/login.html'));web.use(productPages('company'));web.use(createApp({store,allowedOrigins:origins}));const server=web.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port;origins.push(url);let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']}:{})});const context=await browser.newContext({extraHTTPHeaders:{Authorization:'Bearer test'},viewport:{width:1280,height:850}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);console.log('browser ready');
 await page.goto(url+'/enterprise.html');console.log('page loaded');await page.waitForFunction(()=>document.querySelector('#workspace')&&!document.querySelector('#workspace').hidden);await page.waitForFunction(()=>navigator.serviceWorker.controller);console.log('worker ready');await page.waitForTimeout(1000);
 const receipt={operationId:randomUUID(),voucherNumber:'OFF-RECEIPT',lines:[{itemId:item.id,warehouseId:warehouse.id,quantity:'5',unitCost:'10'}]};
 const onlineMaster=await page.evaluate(()=>fetch('/api/v1/master-data').then(r=>r.json()));assert.equal(onlineMaster.items.length,1);
 await page.waitForFunction(()=>document.querySelector('#content')?.textContent.trim().length>0);
 await context.setOffline(true);await page.reload();console.log('offline reloaded');await page.waitForFunction(()=>document.querySelector('#workspace')&&!document.querySelector('#workspace').hidden);
 await page.waitForFunction(()=>document.querySelector('#content')?.textContent.trim().length>0);
 const reservations=await page.evaluate(async()=>{const r=await fetch('/api/v1/inventory/reservations');return {status:r.status,offline:r.headers.get('X-AlMahasib-Offline')};});assert.equal(reservations.status,200);assert.equal(reservations.offline,'true');
 const cached=await page.evaluate(()=>fetch('/api/v1/master-data').then(r=>({offline:r.headers.get('X-AlMahasib-Offline'),data:r.json()})));assert.equal(cached.offline,'true');
 const result=await page.evaluate(async body=>{const r=await fetch('/api/v1/inventory/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};},receipt);assert.equal(result.status,202);assert.equal(store.stockReceipts.size,0);
 await page.close();const resumed=await context.newPage();await resumed.goto(url+'/enterprise.html');await resumed.waitForFunction(()=>window.AlMahasibERP);assert.equal((await resumed.evaluate(()=>AlMahasibERP.status())).pending,1);
 await context.setOffline(false);await resumed.evaluate(()=>AlMahasibERP.synchronize());console.log('sync status',await resumed.evaluate(()=>AlMahasibERP.status()));await resumed.evaluate(()=>AlMahasibERP.review());console.log('queue',await resumed.locator('dialog[open]').innerText());assert.equal(store.stockReceipts.size,1);assert.equal((await resumed.evaluate(()=>AlMahasibERP.status())).pending,0);await resumed.evaluate(()=>AlMahasibERP.synchronize());assert.equal(store.stockReceipts.size,1);await resumed.locator('dialog[open] button').last().click();
 await resumed.evaluate(()=>fetch('/api/v1/master-data'));await context.setOffline(true);
 const issue={operationId:randomUUID(),voucherNumber:'ISSUE-1',reason:'اختبار',lines:[{itemId:item.id,warehouseId:warehouse.id,quantity:'3'}]};
 const issueStatus=await resumed.evaluate(async body=>(await fetch('/api/v1/inventory/issues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,issue);assert.equal(issueStatus,202);
 const excessive=await resumed.evaluate(async body=>(await fetch('/api/v1/inventory/issues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,{...issue,operationId:randomUUID(),voucherNumber:'ISSUE-2'});assert.equal(excessive,409);
 await context.setOffline(false);await resumed.evaluate(()=>AlMahasibERP.synchronize());assert.equal(store.stockIssues.size,1);assert.equal([...store.stockBalances.values()].find(x=>x.itemId===item.id).quantity,'2.000000');
 // Lose the response after the server committed; retry the same durable ID.
 const lost={...receipt,operationId:randomUUID(),voucherNumber:'LOST-RESPONSE'};
 await context.route(url+'/api/v1/inventory/receipts',async route=>{await route.fetch();await route.abort();});
 await resumed.evaluate(async body=>fetch('/api/v1/inventory/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),lost);
 assert.equal(store.stockReceipts.size,2);assert.equal((await resumed.evaluate(()=>AlMahasibERP.status())).pending,1);
 await context.unroute(url+'/api/v1/inventory/receipts');
 await Promise.all([resumed.evaluate(()=>AlMahasibERP.synchronize()),resumed.evaluate(()=>AlMahasibERP.synchronize())]);
 assert.equal(store.stockReceipts.size,2);assert.equal((await resumed.evaluate(()=>AlMahasibERP.status())).pending,0);
 await context.setOffline(true);
 const duplicate=await resumed.evaluate(async body=>(await fetch('/api/v1/inventory/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,voucherNumber:'DIFFERENT'})})).status,lost);assert.equal(duplicate,409);
 assert.deepEqual(errors,[]);const checks=['ERP reload offline','scoped local data','durable pending operation','idempotent reconnect','local stock reservation','lost response retry without duplicate','concurrent synchronization','reject changed payload for same operation ID'];fs.writeFileSync('outputs/company-web-offline-checks.json',JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS',checks.join('; '));await context.unrouteAll({behavior:'wait'});await context.close();
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}





