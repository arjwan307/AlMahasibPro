import {createRequire} from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {PERMISSIONS} from '../../apps/api/src/permissions.js';
const require=createRequire(process.env.PLAYWRIGHT_MODULE_PATH || import.meta.url),{chromium}=require('playwright');
const store=new MemoryStore(),company=await store.registerCompany({code:'offline-test',legalName:'شركة اختبار الجهاز',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'admin',displayName:'مدير',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
const user=store.users.get(company.ownerUserId),auth={company,user,permissions:PERMISSIONS,roles:[],scopes:[],session:{deviceId:'test',expiresAt:new Date(Date.now()+86400000).toISOString()}};store.getSessionContext=async()=>auth;
const unit=await store.createUnit(company.id,{code:'PC',name:'قطعة',decimalPlaces:6},user.id),item=await store.createItem(company.id,{sku:'ITEM-1',name:'صنف الجهاز',baseUnitId:unit.id},user.id),warehouse=await store.createWarehouse(company.id,{code:'MAIN',name:'مخزن الجهاز',kind:'standard'},user.id);
const origins=[];const server=createApp({store,allowedOrigins:origins}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port;origins.push(url);let browser;
fs.mkdirSync('work',{recursive:true});fs.mkdirSync('outputs',{recursive:true});const profile=fs.mkdtempSync('work/erp-cold-profile-');let context;
try{
 const launch=()=>chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,extraHTTPHeaders:{Authorization:'Bearer test'},viewport:{width:1280,height:850}});
 context=await launch();let page=await context.newPage();await page.goto(url+'/enterprise.html');await page.waitForFunction(()=>!document.getElementById('workspace').hidden);await page.waitForFunction(()=>navigator.serviceWorker.controller);await page.evaluate(()=>fetch('/api/v1/master-data'));await page.waitForTimeout(1500);await context.close();
 context=await launch();await context.setOffline(true);page=await context.newPage();await page.goto(url+'/enterprise.html');await page.waitForFunction(()=>!document.getElementById('workspace').hidden);
 const body={operationId:randomUUID(),voucherNumber:'COLD-START',lines:[{itemId:item.id,warehouseId:warehouse.id,quantity:'5',unitCost:'10'}]};
 assert.equal(await page.evaluate(async body=>(await fetch('/api/v1/inventory/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,body),202);assert.equal(store.stockReceipts.size,0);await context.close();
 context=await launch();await context.setOffline(true);page=await context.newPage();await page.goto(url+'/enterprise.html');await page.waitForFunction(()=>window.AlMahasibERP);assert.equal((await page.evaluate(()=>AlMahasibERP.status())).pending,1);await context.setOffline(false);await page.evaluate(()=>AlMahasibERP.synchronize());assert.equal(store.stockReceipts.size,1);
 await page.goto(url+'/market-cashier.html');await page.waitForFunction(()=>document.body.classList.contains('cashier-layout'));await page.screenshot({path:'outputs/ERP-1.2.4-cashier.png',fullPage:true});
 await context.close();context=null;
 const loginContext=await chromium.launch({channel:'msedge',headless:true});browser=loginContext;const loginPage=await loginContext.newPage();await loginPage.route('**/api/v1/bootstrap',route=>route.fulfill({status:401,json:{error:{message:'Login'}}}));await loginPage.route('**/api/local/status',route=>route.fulfill({json:{local:true,initialized:true,companyCode:'offline-test'}}));await loginPage.goto(url+'/enterprise.html');await loginPage.waitForFunction(()=>!document.getElementById('entry').hidden);await loginPage.waitForFunction(()=>document.getElementById('loginCompanyChoice'));assert.equal(await loginPage.locator('#login input[name=companyCode]').inputValue(),'offline-test');assert(await loginPage.locator('#login input[name=companyCode]').isHidden());await loginPage.locator('#login input[name=username]').fill('مدير');await loginPage.locator('#login input[name=password]').fill('valid-password');assert.equal(await loginPage.locator('#login input[name=username]').inputValue(),'مدير');await loginPage.screenshot({path:'outputs/ERP-1.2.4-login.png'});
 fs.writeFileSync('outputs/ERP-1.2.4-cold-start.json',JSON.stringify({passed:true,checks:['full browser exit','offline cold launch','durable write while offline','second browser restart preserves operation','reconnect commits once','login fields editable','cashier controls grouped']},null,2));console.log('PASS: offline cold start, persisted operation, login fields and grouped cashier controls');
}finally{await context?.close();await browser?.close();await new Promise(r=>server.close(r));}


