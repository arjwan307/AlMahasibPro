// Uses the real ERP, synchronization client and browser. No production records.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {PERMISSIONS} from '../../apps/api/src/permissions.js';

const require=createRequire(process.env.PLAYWRIGHT_MODULE_PATH||new URL('../../package.json',import.meta.url));
const {chromium}=require('playwright');
const store=new MemoryStore();
const company=await store.registerCompany({code:'draft-test',legalName:'شركة اختبار المسودات',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'admin',displayName:'مدير الاختبار',passwordHash:'test'}});
await store.approveCompany(company.id,company.ownerUserId);
const user=store.users.get(company.ownerUserId),account={company,user,permissions:PERMISSIONS,roles:[],scopes:[],session:{expiresAt:new Date(Date.now()+86400000).toISOString(),deviceId:'browser-test'}};
store.getSessionContext=async()=>account;
const unit=await store.createUnit(company.id,{code:'PC',name:'قطعة',decimalPlaces:6},user.id);
const secondUnit=await store.createUnit(company.id,{code:'KG',name:'كغم',decimalPlaces:6},user.id);
const item=await store.createItem(company.id,{sku:'A1',name:'مادة الاختبار',baseUnitId:unit.id},user.id);
const warehouse=await store.createWarehouse(company.id,{code:'MAIN',name:'المخزن الرئيسي'},user.id);
const customer=await store.createParty(company.id,'customer',{code:'C1',name:'عميل الاختبار'},user.id);
const supplier=await store.createParty(company.id,'supplier',{code:'S1',name:'مورد الاختبار'},user.id);
store.stockBalances.set(company.id+':'+warehouse.id+':'+item.id,{companyId:company.id,warehouseId:warehouse.id,itemId:item.id,quantity:'50',averageCost:'10',version:1});
for(const type of ['sale','sale_retail','purchase']){const id=randomUUID();store.prices.set(id,{id,companyId:company.id,itemId:item.id,unitId:unit.id,priceType:type,amount:'100',currency:'IQD',active:true,validFrom:new Date().toISOString()});}
for(const type of ['sale','purchase']){const id=randomUUID();store.commerceDocuments.set(id,{id,companyId:company.id,documentType:type,documentNumber:type+'-1',warehouseId:warehouse.id,customerId:customer.id,supplierId:supplier.id,status:'posted',currency:'IQD',subtotal:'100',paidAmount:'0',dueAmount:'100',occurredAt:new Date().toISOString(),lines:[{itemId:item.id,unitId:unit.id,quantity:'1',unitPrice:'100',lineTotal:'100'}],payments:[]});}
const origins=[],app=createApp({store,allowedOrigins:origins});
let nextMasterGate=null,nextSalesGate=null;
const server=createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/api/v1/master-data'&&nextMasterGate){const gate=nextMasterGate;nextMasterGate=null;gate.started();await gate.promise;}
 if(req.method==='GET'&&req.url==='/api/v1/sales/bootstrap'&&nextSalesGate){const gate=nextSalesGate;nextSalesGate=null;gate.started();res.once('finish',gate.finished);res.once('close',gate.finished);await gate.promise;if(gate.reject){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'stale sales request failed'}}));return;}}
 if(process.env.ERP_SOURCE_DIR&&['/enterprise.js','/sales-workspace.js','/company-sync-ui.js','/company-output.js'].includes(req.url.split('?')[0])){
  try{res.writeHead(200,{'Content-Type':'application/javascript'});res.end(await readFile(join(process.env.ERP_SOURCE_DIR,req.url.split('?')[0].slice(1))));return;}catch{res.writeHead(404);res.end();return;}
 }
 app(req,res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;origins.push(origin);
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 const context=await browser.newContext({extraHTTPHeaders:{Authorization:'Bearer test'},viewport:{width:1400,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.goto(origin+'/enterprise.html');await page.waitForFunction(()=>!document.getElementById('workspace').hidden);
 const synchronize=()=>page.evaluate(async()=>{await AlMahasibERP.synchronize();await AlMahasibOutput().refresh({background:true});});
 const go=async view=>{await page.locator('nav [data-view="'+view+'"]').evaluate(button=>{const group=button.closest('details');if(group)group.open=true;});await page.locator('nav [data-view="'+view+'"]').click();await page.waitForFunction(view=>AlMahasibOutput().view===view,view);if(view==='warehouses')await page.locator('#warehouseCreateFold').evaluate(details=>details.open=true);};
 await synchronize();
 const cases=[
  ['items','#editor [name="name"]'],['units','#editor [name="name"]'],['warehouses','#editor [name="name"]'],
  ['customers','#editor [name="name"]'],['suppliers','#editor [name="name"]'],['branches','#branchEditor [name="name"]'],
  ['users','#userEditor [name="username"]'],['ledger','#manualJournal [name="description"]'],
  ['inventory','#stockReceiptForm [name="counterparty"]'],['payroll','#payrollEmployee [name="fullName"]'],
  ['treasury','#cashboxCreate [name="name"]'],['imports','#lgShipmentCreate [name="shipmentNumber"]'],
  ['purchase','#commerce [name="documentNumber"]']
 ];
 for(const [view,selector] of cases){
  await go(view);if(view==='imports')await page.locator('[data-lg-action="new"]').click();const input=page.locator(selector);await input.waitFor();const value='مسودة '+view;
  await input.fill(value);await page.locator('#pageTitle').click();
  await synchronize();assert.equal(await input.inputValue(),value,view+' fields survive synchronization after blur');
 }
 console.log('PASS: unsaved text fields survive synchronization in 13 ERP sections');

 await go('items');const description=page.locator('#editor textarea[name="description"]');await description.fill('وصف المادة غير المحفوظ');await page.locator('#pageTitle').click();await synchronize();assert.equal(await description.inputValue(),'وصف المادة غير المحفوظ');
 await go('units');await page.locator('#conversion [name="unitId"]').selectOption(secondUnit.id);await page.locator('#pageTitle').click();await synchronize();assert.equal(await page.locator('#conversion [name="unitId"]').inputValue(),secondUnit.id);
 await go('users');const check=page.locator('#roleEditor [name="permissions"]').first();await check.check();await page.locator('#pageTitle').click();await synchronize();assert.equal(await check.isChecked(),true);
 console.log('PASS: textarea, selected options and permission checkboxes survive synchronization');

 await go('items');await page.locator('#editor [name="name"]').fill('مسودة أثناء المزامنة اليدوية');
 await page.locator('#companySyncPanel summary').click();await page.locator('#companySyncNow').click();
 await page.waitForFunction(()=>!document.getElementById('companySyncNow').disabled);assert.equal(await page.locator('#editor [name="name"]').inputValue(),'مسودة أثناء المزامنة اليدوية');
 console.log('PASS: manual sync keeps unfinished fields');

 await go('inventory');await page.locator('[data-stock-add="receipt"]').click();const count=await page.locator('[data-stock-row="receipt"]').count();await synchronize();assert.equal(await page.locator('[data-stock-row="receipt"]').count(),count);
 console.log('PASS: additional inventory rows remain even before values are entered');

 await go('items');await page.evaluate(()=>document.querySelector('[data-item-code]').click());
 const dialog=page.locator('dialog[open]');await dialog.locator('[name="sku"]').fill('NEW-CODE');await synchronize();assert.equal(await dialog.locator('[name="sku"]').inputValue(),'NEW-CODE');await dialog.locator('[data-close]').click();
 console.log('PASS: editing dialogs remain open and preserve their data');

 await go('units');let release,started;
 const start=new Promise(resolve=>started=resolve);nextMasterGate={started,promise:new Promise(resolve=>release=resolve)};
 const refresh=page.evaluate(()=>AlMahasibOutput().refresh({background:true}));await start;
 await page.locator('#editor [name="name"]').fill('كتابة بدأت أثناء التحديث');await page.locator('#pageTitle').click();release();await refresh;
 assert.equal(await page.locator('#editor [name="name"]').inputValue(),'كتابة بدأت أثناء التحديث');
 console.log('PASS: a refresh already in flight cannot erase newly entered text');

 await go('units');let releaseView,startedView;
 const viewStart=new Promise(resolve=>startedView=resolve);nextMasterGate={started:startedView,promise:new Promise(resolve=>releaseView=resolve)};
 const oldRefresh=page.evaluate(()=>AlMahasibOutput().refresh({background:true}));await viewStart;
 await go('items');await page.locator('#editor [name="name"]').fill('مسودة في صفحة أخرى');releaseView();await oldRefresh;
 assert.equal(await page.locator('#editor [name="name"]').inputValue(),'مسودة في صفحة أخرى');
 console.log('PASS: a late refresh for another page cannot replace the current page');

 await go('sale');await page.locator('#startSalesInvoice').click();await page.locator('[name="saleNumber"]').waitFor();await page.locator('[name="saleNumber"]').fill('UNFINISHED-SALE');await page.locator('#pageTitle').click();await synchronize();assert.equal(await page.locator('[name="saleNumber"]').inputValue(),'UNFINISHED-SALE');
 await page.locator('[data-item="'+item.id+'"]').click();await page.locator('#salesLines [data-quantity]').fill('2.');await synchronize();assert.equal(await page.locator('#salesLines [data-quantity]').inputValue(),'2.');
 console.log('PASS: sales header and incomplete quantity entry survive synchronization');

 await go('units');await page.locator('#editor [name="code"]').fill('BOX');await page.locator('#editor [name="name"]').fill('وحدة محفوظة');await page.locator('#editor button').click();
 await page.waitForFunction(()=>AlMahasibOutput().master.units.some(unit=>unit.code==='BOX'));
 await page.waitForFunction(()=>document.querySelector('#editor [name="name"]').value==='');
 assert.ok([...store.units.values()].some(unit=>unit.code==='BOX'));
 await page.locator('#editor [name="code"]').fill('BOX');await page.locator('#editor [name="name"]').fill('اسم لا ينبغي مسحه عند الخطأ');await page.locator('#editor button').click();
 await page.waitForFunction(()=>!document.querySelector('#editor button').disabled);assert.equal(await page.locator('#editor [name="name"]').inputValue(),'اسم لا ينبغي مسحه عند الخطأ');
 console.log('PASS: confirmed saves clear the saved form; rejected saves preserve it');

 await go('units');await store.createUnit(company.id,{code:'SERVER-NEW',name:'تغيير من الخادم',decimalPlaces:0},user.id);await synchronize();
 await page.waitForFunction(()=>[...document.querySelector('#conversion [name="unitId"]').options].some(option=>option.textContent.includes('تغيير من الخادم')));
 assert.equal(await page.locator('#editor [name="name"]').inputValue(),'');
 console.log('PASS: idle pages still receive fresh server data');
 await page.evaluate(()=>{const fetch=window.fetch;window.fetch=(input,options={})=>fetch(input,String(input).includes('/api/v1/sales/bootstrap')?{...options,signal:AbortSignal.timeout(15000)}:options);});
 for(const reject of [false,true]){
  await go('units');let releaseSales,startedSales,finishedSales;
  const salesStart=new Promise(resolve=>startedSales=resolve),salesFinish=new Promise(resolve=>finishedSales=resolve);
  nextSalesGate={reject,started:startedSales,finished:finishedSales,promise:new Promise(resolve=>releaseSales=resolve)};
  await go('sale');await Promise.race([salesStart,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sales request did not start')),5000))]);await go('overview');await go('sale');
  await page.locator('#startSalesInvoice').click();await page.locator('[name="saleNumber"]').fill('CURRENT-INVOICE');
  await page.evaluate(()=>window.currentInvoiceField=document.querySelector('[name="saleNumber"]'));
  releaseSales();await Promise.race([salesFinish,new Promise((_,reject)=>setTimeout(()=>reject(Error('Sales request did not finish')),5000))]);await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.currentInvoiceField.isConnected),true);
  assert.equal(await page.locator('[name="saleNumber"]').inputValue(),'CURRENT-INVOICE');
 }
 console.log('PASS: stale sales success and failure cannot replace a newer invoice editor');
 assert.deepEqual(errors,[]);
}finally{nextMasterGate=null;nextSalesGate=null;await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
