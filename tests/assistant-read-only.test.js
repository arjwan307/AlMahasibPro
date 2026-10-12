import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installAssistantRoutes} from '../apps/api/src/modules/assistant/routes.js';
import {assistantReadStore} from '../apps/api/src/modules/assistant/read-only.js';

const permissions=['assistant.use','accounting.read','accounting.post','catalog.read','inventory.read','sales.read','purchasing.read','customers.read','company.manage'];
const auth={company:{id:'co',currency:'IQD'},user:{id:'u'},roles:[],permissions,scopes:[{type:'warehouse',id:'w1'}]};
const date='2026-10-05T12:00:00Z';
const invoice=(id,type,amount,paid,warehouseId='w1',currency='IQD')=>({id,companyId:'co',documentNumber:id,documentType:type,warehouseId,occurredAt:date,status:'posted',currency,subtotal:amount,grossAmount:amount,paidAmount:paid,dueAmount:String(Number(amount)-Number(paid)),customerId:'c1',lines:[{itemId:'i1',unitId:'piece',quantity:'2',lineTotal:amount,unitCost:'SECRET-COST'}],payments:[{amount:paid}]});
function fixture(){
 const master={items:[{id:'i1',sku:'A1',name:'صنف الاختبار',baseUnitId:'piece',units:[{unitId:'piece',conversionFactor:'1'},{unitId:'box',conversionFactor:'10'}]}],units:[{id:'piece',name:'قطعة'},{id:'box',name:'صندوق'}],customers:[{id:'c1',code:'C1',name:'عميل الاختبار'}],warehouses:[{id:'w1',name:'المسموح'},{id:'w2',name:'المحجوب'}],stock:[{itemId:'i1',warehouseId:'w1',quantity:'-1'},{itemId:'i1',warehouseId:'w2',quantity:'-500'}],prices:[{itemId:'i1',unitId:'piece',priceType:'sale',currency:'IQD',amount:'0',validFrom:'2026-01-01'}]};
 const documents=[invoice('S1','sale','100','80'),invoice('R1','sale_return','10','10'),invoice('P1','purchase','200','150'),invoice('USD1','sale','30','0','w1','USD'),invoice('HIDDEN','sale','1000','0','w2'),{...invoice('DRAFT','sale','900','0'),status:'draft'},{...invoice('OLD','sale','600','0'),occurredAt:'2026-09-01'}];
 const chartAccounts=[{code:'CASH',name:'الصندوق',type:'asset',active:true},{code:'REV',name:'الإيرادات',type:'revenue',active:true},{code:'EXP',name:'المصروفات',type:'expense',active:true}];
 const journals=[{id:'j1',companyId:'co',warehouseId:'w1',status:'posted',entryNumber:'J1',occurredAt:date,currency:'IQD',lines:[{accountCode:'CASH',debit:'100',credit:'0'},{accountCode:'REV',debit:'0',credit:'90'}]},{id:'j2',companyId:'co',warehouseId:'w2',status:'posted',entryNumber:'HIDDEN-J',occurredAt:date,currency:'IQD',lines:[{accountCode:'CASH',debit:'7777',credit:'0'}]}];
 const store={master,documents,journals,salesSettings:new Map(),warehouses:new Map([['w1',{id:'w1',companyId:'co',branchId:'b1'}],['w2',{id:'w2',companyId:'co',branchId:'b2'}]]),stocktakes:new Map([['ct',{id:'ct',companyId:'co',status:'posted',warehouseId:'w1',stocktakeNumber:'COUNT-1',countedAt:date,lines:[{itemId:'i1',book:'5',counted:'6',delta:'1'}]}]]),stockReceipts:new Map([['rc',{companyId:'co',status:'posted',voucherNumber:'IN-1',occurredAt:date,lines:[{warehouseId:'w1',itemId:'i1',quantity:'5'}]}]]),stockIssues:new Map([['is',{companyId:'co',status:'posted',voucherNumber:'OUT-1',occurredAt:date,lines:[{warehouseId:'w1',itemId:'i1',quantity:'1'}]}]]),stockTransfers:new Map([['tr',{companyId:'co',status:'posted',transferNumber:'TR-1',occurredAt:date,sourceWarehouseId:'w1',destinationWarehouseId:'w2',lines:[{itemId:'i1',quantity:'2'}]}]]),stockWriteoffs:new Map([['ls',{companyId:'co',warehouseId:'w1',itemId:'i1',quantity:'1',writeoffNumber:'LOSS-1',occurredAt:date}]]),financialRecords:new Map(),debtMovements:new Map(),listMasterData:async()=>master,listCommerceDocuments:async()=>documents,listEnterpriseData:async()=>({chartAccounts,journals,trialBalance:[{accountCode:'CASH',name:'الصندوق',currency:'IQD',debit:'99999',credit:'0',balance:'99999'}]}),listChartAccounts:async()=>chartAccounts,trialBalance:async()=>[]};
 for(const name of ['createJournal','postJournal','saveSalesSetting','createParty','receiveStock','issueStock','transaction'])store[name]=()=>{throw Error('A read-only assistant must never call '+name);};
 return store;
}
function routes(store){const handlers={};installAssistantRoutes({get:(path,_middleware,handler)=>handlers['GET '+path]=handler,post:(path,_middleware,handler)=>handlers['POST '+path]=handler},{authenticate:()=>{},store});return handlers;}
async function chat(store,message,extra={},context=auth){const response={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await routes(store)['POST /api/v1/assistant/chat']({auth:context,body:{messages:[{role:'user',content:message}],...extra}},response);return response;}
const query=label=>label+' من 2026-10-01 إلى 2026-10-31';
const snapshot=store=>JSON.stringify([store.master,store.documents,store.journals,...Object.values(store).filter(x=>x instanceof Map).map(m=>[...m])]);

test('reports sum returns by currency and filter draft, dates and warehouse scope',async()=>{
 const store=fixture(),before=snapshot(store);
 const sales=await chat(store,query('تقرير المبيعات'));
 assert.equal(sales.statusCode,200);assert.equal(sales.body.report.rows.length,3);
 assert.deepEqual(sales.body.reports[0].rows,[['IQD',2,1,'90.000000','70.000000','20.000000'],['USD',1,0,'30.000000','0.000000','30.000000']]);
 const purchases=await chat(store,query('كشف المشتريات'));
 assert.equal(purchases.body.report.rows.length,1);assert.equal(purchases.body.report.rows[0][1],'P1');
 assert.doesNotMatch(JSON.stringify(sales.body),/HIDDEN|DRAFT|OLD|SECRET-COST/);
 assert.equal(snapshot(store),before);
});

test('goods movement includes receiving, issuing, transfer, count and damage with signed base quantities',async()=>{
 const store=fixture(),response=await chat(store,query('حركة البضاعة'));
 assert.equal(response.statusCode,200);
 const byRef=new Map(response.body.report.rows.map(row=>[row[1],row]));
 assert.equal(byRef.get('IN-1')[9],'5.000000');assert.equal(byRef.get('OUT-1')[9],'-1.000000');
 assert.equal(byRef.get('TR-1')[9],'-2.000000');assert.equal(byRef.get('COUNT-1')[9],'1.000000');assert.equal(byRef.get('LOSS-1')[9],'-1.000000');
 assert.doesNotMatch(JSON.stringify(response.body),/المحجوب|HIDDEN|SECRET-COST/);
 const counts=await chat(store,query('كشف الجرد'));
 assert.deepEqual(counts.body.report.rows[0].slice(5),['5.000000','6.000000','1.000000','فرق جرد يحتاج مراجعة']);
});

test('financial activity and trial balance remain scoped even when a backend ignores the scope argument',async()=>{
 const store=fixture(),response=await chat(store,query('كشف الحركات المالية'));
 assert.equal(response.statusCode,200);assert.equal(response.body.report.rows.length,2);
 assert.deepEqual(response.body.reports[0].rows,[['IQD','100.000000','90.000000','10.000000']]);
 const trial=await chat(store,'ميزان المراجعة');
 assert.doesNotMatch(JSON.stringify(trial.body),/99999|7777|HIDDEN-J/);
 assert.equal(trial.body.report.rows[0][3],'100.000000');
});

test('comprehensive review detects errors without provider access, write calls or source mutations',async()=>{
 const store=fixture(),before=snapshot(store),original=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('Company records must not reach a provider');};
 try{
  const response=await chat(store,query('اكتشاف الأخطاء'));
  assert.equal(response.statusCode,200);assert.equal(response.body.readOnly,true);assert.equal(response.body.localOnly,true);
  const rows=new Map(response.body.report.rows.map(row=>[row[0],row]));
  assert.equal(rows.get('مراجعة القيود')[2],1);assert.equal(rows.get('مراجعة الأسعار')[2],2);assert.equal(rows.get('تنبيهات المخزون')[2],1);
  assert.equal(response.body.reports.length,5);assert.ok(response.body.report.generatedAt);
  assert.doesNotMatch(JSON.stringify(response.body),/HIDDEN|SECRET-COST/);
  assert.equal(snapshot(store),before);
 }finally{globalThis.fetch=original;}
});

test('write requests and unknown tool IDs are rejected before source or provider calls',async()=>{
 const store=new Proxy({}, {get(){throw Error('No source must be touched');}});
 for(const message of ['أنشئ قيد مالي','جهز مسودة قيد','رحل القيود المالية','عدل سعر الصنف','احذف الفواتير','أرسل إشعار للعميل','create journal entry']){
  const response=await chat(store,message);assert.equal(response.statusCode,403);assert.equal(response.body.error.code,'ASSISTANT_READ_ONLY');
 }
 const response=await chat(store,'نفذ الطلب',{toolId:'post-journal'});assert.equal(response.body.error.code,'ASSISTANT_TOOL_FORBIDDEN');
});

test('tool listing and report execution enforce read permissions independently of posting permission',async()=>{
 const context={...auth,permissions:['assistant.use','sales.read','accounting.post']},store=fixture();
 let body;routes(store)['GET /api/v1/assistant/tools']({auth:context},{json(value){body=value;}});
 assert.ok(body.tools.some(t=>t.id==='sales-report'));assert.ok(!body.tools.some(t=>t.id==='journal-audit'||t.id==='purchase-report'));
 const denied=await chat(store,query('كشف الحركات المالية'),{},context);assert.equal(denied.statusCode,403);
 const forged=await chat(store,'تقرير المبيعات',{toolId:'purchase-report'},context);assert.equal(forged.statusCode,403);
 const period=await chat(store,'تقرير المبيعات من 2026-10-31 إلى 2026-10-01');assert.equal(period.statusCode,400);
});

test('read facade exposes no write methods and detaches mutable data returned by the source',async()=>{
 const store=fixture(),before=snapshot(store),view=assistantReadStore(store,auth);
 assert.equal(view.createJournal,undefined);assert.equal(view.transaction,undefined);
 view.stocktakes.get('ct').lines[0].counted='999';view.stocktakes.clear();
 const master=await view.listMasterData('co');master.items[0].name='changed';
 assert.equal(snapshot(store),before);
 await assert.rejects(view.listMasterData('other-company'),/ASSISTANT_COMPANY_SCOPE/);
});

test('price review distinguishes units and sales channel without exposing hidden costs or channels',async()=>{
 const store=fixture();store.salesSettings.set('user:u',{salesManager:true,channel:'wholesale'});
 store.master.prices.push({itemId:'i1',unitId:'piece',priceType:'sale_wholesale',currency:'IQD',amount:'5',validFrom:'2026-01-01'},{itemId:'i1',unitId:'box',priceType:'sale_retail',currency:'IQD',amount:'PRIVATE-RETAIL',validFrom:'2026-01-01'});
 const response=await chat(store,'راجع الأسعار');
 assert.equal(response.statusCode,200);assert.ok(response.body.report.rows.some(row=>row[0].includes('box')&&row[5].includes('لا يوجد سعر')));
 assert.doesNotMatch(JSON.stringify(response.body),/PRIVATE-RETAIL|SECRET-COST/);
});

test('an unavailable review source stays incomplete instead of being reported as clean',async()=>{
 const store=fixture();store.listMasterData=async()=>{throw Error('source unavailable');};
 const response=await chat(store,'مراجعة شاملة');
 assert.equal(response.statusCode,200);
 const failed=response.body.report.rows.filter(row=>row[1]==='تعذر الفحص');
 assert.equal(failed.length,3);assert.ok(failed.every(row=>row[2]==='—'));
 assert.ok(response.body.report.rows.some(row=>row[0]==='مراجعة القيود'&&row[2]===1));
});

test('corrupt scoped journal amounts are reported by audit and cannot become a false trial balance',async()=>{
 const store=fixture();store.journals[0].lines[0].debit='INVALID';
 const audit=await chat(store,'راجع القيود');assert.equal(audit.statusCode,200);assert.match(audit.body.answer,/مبلغ سطر غير صالح/);
 const trial=await chat(store,'ميزان المراجعة');assert.equal(trial.statusCode,409);assert.equal(trial.body.error.code,'ASSISTANT_BALANCE_INVALID');
});

test('creating a report is permitted while an additional posting or editing instruction remains blocked',async()=>{
 const store=fixture();
 const read=await chat(store,'أنشئ كشف المخزون');assert.equal(read.statusCode,200);assert.equal(read.body.readOnly,true);
 const write=await chat(store,'أنشئ كشف المخزون ثم عدل الأرصدة');assert.equal(write.statusCode,403);assert.equal(write.body.error.code,'ASSISTANT_READ_ONLY');
});
