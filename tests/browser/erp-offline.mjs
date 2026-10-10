import {createRequire} from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {PERMISSIONS} from '../../apps/api/src/permissions.js';
const require=createRequire(process.env.PLAYWRIGHT_MODULE_PATH || new URL('../../package.json',import.meta.url)),{chromium}=require('playwright');
fs.mkdirSync('outputs',{recursive:true});
const store=new MemoryStore(),company=await store.registerCompany({code:'offline-test',legalName:'شركة اختبار الجهاز',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'admin',displayName:'مدير',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
const user=store.users.get(company.ownerUserId),auth={company,user,permissions:PERMISSIONS,roles:[],scopes:[],session:{deviceId:'test',expiresAt:new Date(Date.now()+86400000).toISOString()}};store.getSessionContext=async()=>auth;
const unit=await store.createUnit(company.id,{code:'PC',name:'قطعة',decimalPlaces:6},user.id),item=await store.createItem(company.id,{sku:'ITEM-1',name:'صنف الجهاز',baseUnitId:unit.id},user.id),warehouse=await store.createWarehouse(company.id,{code:'MAIN',name:'مخزن الجهاز',kind:'standard'},user.id);
const origins=[];const server=createApp({store,allowedOrigins:origins}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port;origins.push(url);let browser;
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({extraHTTPHeaders:{Authorization:'Bearer test'},viewport:{width:1280,height:850}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url+'/enterprise.html');await page.waitForFunction(()=>document.querySelector('#workspace')&&!document.querySelector('#workspace').hidden);await page.waitForFunction(()=>navigator.serviceWorker.controller);await page.waitForTimeout(1000);
 const receipt={operationId:randomUUID(),voucherNumber:'OFF-RECEIPT',lines:[{itemId:item.id,warehouseId:warehouse.id,quantity:'5',unitCost:'10'}]};
 const onlineMaster=await page.evaluate(()=>fetch('/api/v1/master-data').then(r=>r.json()));assert.equal(onlineMaster.items.length,1);
 await context.setOffline(true);await page.reload();await page.waitForFunction(()=>document.querySelector('#workspace')&&!document.querySelector('#workspace').hidden);
 const cached=await page.evaluate(()=>fetch('/api/v1/master-data').then(r=>({offline:r.headers.get('X-AlMahasib-Offline'),data:r.json()})));assert.equal(cached.offline,'true');
 const result=await page.evaluate(async body=>{const r=await fetch('/api/v1/inventory/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};},receipt);assert.equal(result.status,202);assert.equal(store.stockReceipts.size,0);
 await page.close();const resumed=await context.newPage();await resumed.goto(url+'/enterprise.html');await resumed.waitForFunction(()=>window.AlMahasibERP);assert.equal((await resumed.evaluate(()=>AlMahasibERP.status())).pending,1);
 await context.setOffline(false);await resumed.evaluate(()=>AlMahasibERP.synchronize());console.log('sync status',await resumed.evaluate(()=>AlMahasibERP.status()));await resumed.evaluate(()=>AlMahasibERP.review());console.log('queue',await resumed.locator('dialog[open]').innerText());assert.equal(store.stockReceipts.size,1);assert.equal((await resumed.evaluate(()=>AlMahasibERP.status())).pending,0);await resumed.evaluate(()=>AlMahasibERP.synchronize());assert.equal(store.stockReceipts.size,1);await resumed.locator('dialog[open] button').last().click();
 await resumed.evaluate(()=>fetch('/api/v1/master-data'));await context.setOffline(true);
 const issue={operationId:randomUUID(),voucherNumber:'ISSUE-1',reason:'اختبار',lines:[{itemId:item.id,warehouseId:warehouse.id,quantity:'3'}]};
 const issueStatus=await resumed.evaluate(async body=>(await fetch('/api/v1/inventory/issues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,issue);assert.equal(issueStatus,202);
 const excessive=await resumed.evaluate(async body=>(await fetch('/api/v1/inventory/issues',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,{...issue,operationId:randomUUID(),voucherNumber:'ISSUE-2'});assert.equal(excessive,409);
 await context.setOffline(false);await resumed.evaluate(()=>AlMahasibERP.synchronize());assert.equal(store.stockIssues.size,1);assert.equal([...store.stockBalances.values()].find(x=>x.itemId===item.id).quantity,'2.000000');
 // Simulate a branch HTTPS endpoint with the same identity; only API transport is mocked.
 let lanWrites=0;
 await context.route('https://branch.example.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/v1/auth/login')return route.fulfill({json:{token:'test'}});
  if(route.request().method()==='POST')lanWrites++;
  const response=await route.fetch({url:url+path});await route.fulfill({response});
 });
 await resumed.evaluate(()=>AlMahasibERP.configureLAN());const inputs=resumed.locator('dialog[open] input');await inputs.nth(0).fill('https://branch.example.test');await inputs.nth(1).fill('offline-test');await inputs.nth(2).fill('admin');await inputs.nth(3).fill('test');await resumed.getByRole('button',{name:'تحقق واحفظ',exact:true}).click();await resumed.waitForFunction(()=>!document.querySelector('dialog[open]'));await resumed.evaluate(()=>AlMahasibERP.synchronize());
 await context.route(url+'/api/**',route=>route.abort());await resumed.evaluate(()=>AlMahasibERP.synchronize());assert((await resumed.evaluate(()=>AlMahasibERP.status())).connection.includes('شبكة الفرع'));
 const lanReceipt={...receipt,operationId:randomUUID(),voucherNumber:'LAN-RECEIPT'};assert.equal(await resumed.evaluate(async body=>(await fetch('/api/v1/inventory/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,lanReceipt),202);await resumed.evaluate(()=>AlMahasibERP.synchronize());assert.equal(lanWrites,1);assert.equal(store.stockReceipts.size,2);await context.unroute(url+'/api/**');
 await resumed.goto(url+'/market-cashier.html');await resumed.waitForFunction(()=>window.PosUI&&window.AlMahasibMarketOffline);resumed.on('dialog',d=>d.dismiss());
 await resumed.evaluate(()=>{window.prompt=()=>{throw Error('prompt is unavailable in Electron');};void PosUI.openShift();});await resumed.locator('dialog[open] input').fill('كاشير الاختبار');await resumed.locator('dialog[open] button').first().click();await resumed.waitForFunction(()=>document.getElementById('marketShiftInfo').textContent.includes('الشفت مفتوح'));
 await context.setOffline(true);await resumed.reload();await resumed.waitForFunction(()=>window.PosUI);assert((await resumed.locator('#cashierName').innerText()).includes('كاشير الاختبار'));
 await resumed.screenshot({path:'outputs/ERP-1.2.3-offline-cashier.png',fullPage:true});
 assert.deepEqual(errors,[]);const checks=['ERP reload offline','scoped local data','durable pending operation','idempotent reconnect','local stock reservation','verified LAN fallback (mock HTTPS endpoint)','cashier shift without native prompt','cashier reload offline'];fs.writeFileSync('outputs/ERP-1.2.3-browser-checks.json',JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS',checks.join('; '));
}finally{await browser?.close();await new Promise(r=>server.close(r));}





