import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {hashToken} from '../../apps/api/src/lib/security.js';
import {PERMISSIONS,ROLE_TEMPLATES} from '../../apps/api/src/permissions.js';

test('assistant prepares real priced invoices, submits once for approval and reconciles actual evidence without posting',async()=>{
 const store=new MemoryStore();const company=await store.registerCompany({code:'workbench',legalName:'Workbench test',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'admin',displayName:'Admin',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
 const owner=store.users.get(company.ownerUserId),seller=await store.createUser(company.id,{username:'seller',displayName:'Seller',roleCode:'representative',passwordHash:'test'},owner.id),unit=await store.createUnit(company.id,{code:'PC',name:'قطعة',decimalPlaces:6},owner.id),item=await store.createItem(company.id,{sku:'A1',name:'كرسي',baseUnitId:unit.id},owner.id),warehouse=await store.createWarehouse(company.id,{code:'MAIN',name:'المخزن'},owner.id),customer=await store.createParty(company.id,'customer',{code:'C1',name:'الزبون',creditLimit:'1000'},owner.id);
 store.stockBalances.set(company.id+':'+warehouse.id+':'+item.id,{companyId:company.id,warehouseId:warehouse.id,itemId:item.id,quantity:'10.000000',averageCost:'10.000000',version:1});const priceId=randomUUID();store.prices.set(priceId,{id:priceId,companyId:company.id,itemId:item.id,unitId:unit.id,priceType:'sale_retail',amount:'100',currency:'IQD',active:true});
 const session={expiresAt:new Date(Date.now()+86400000).toISOString(),deviceId:'test'},admin={company,user:owner,permissions:PERMISSIONS,roles:[],scopes:[],session},rep={...admin,user:seller,permissions:ROLE_TEMPLATES.representative,roles:[{code:'representative'}]},blocked={...admin,scopes:[{type:'warehouse',id:randomUUID()}]},reader={...admin,permissions:ROLE_TEMPLATES.auditor};store.getSessionContext=async token=>token===hashToken('rep')?rep:token===hashToken('blocked')?blocked:token===hashToken('reader')?reader:admin;
 const server=createApp({store}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const request=async(path,body,token='admin')=>{const r=await fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const message='أعد فاتورة للزبون "C1" المخزن "MAIN" الصنف "A1" الكمية 2 خصم 12٪';
 try{
  const prepared=await request('/api/v1/assistant/workbench/prepare',{message},'rep');assert.equal(prepared.status,200,JSON.stringify(prepared.data));assert.equal(prepared.data.total,'176.000000');assert.equal(prepared.data.document.discountAmount,'24.000000');assert.equal(prepared.data.document.payments.length,0);assert.equal(store.commerceDocuments.size,0);assert.equal(store.journalEntries.size,0);
  assert.equal((await request('/api/v1/assistant/workbench/prepare',{message},'reader')).status,403);assert.equal((await request('/api/v1/assistant/workbench/prepare',{message},'blocked')).status,409);
  assert.equal((await request('/api/v1/assistant/workbench/prepare',{message:message.replace('2 خصم','20 خصم')},'rep')).status,409);
  assert.equal((await request('/api/v1/assistant/workbench/prepare',{message:message+' الصنف "غير موجود" الكمية 1'},'rep')).status,409);
  assert.equal((await request('/api/v1/assistant/workbench/prepare',{message:message+' نقدي'},'rep')).status,400);
  const body={requestId:prepared.data.requestId,document:prepared.data.document,internalNote:'مراجعة'};const sent=await request('/api/v1/sales/approvals',body,'rep'),again=await request('/api/v1/sales/approvals',body,'rep');assert.equal(sent.status,201);assert.equal(again.data.approval.id,sent.data.approval.id);assert.equal(store.salesApprovals.size,1);assert.equal(store.commerceDocuments.size,0);assert.equal(store.journalEntries.size,0);
  assert.equal((await request('/api/v1/sales/approvals',{...body,document:{...body.document,documentNumber:'CHANGED'}},'rep')).status,409);
  await request('/api/v1/sales/approvals/'+sent.data.approval.id+'/decision',{status:'approved'});
  const sale=await request('/api/v1/commerce/commit',{operationId:randomUUID(),deviceId:'test',clientSequence:1,occurredAt:new Date().toISOString(),document:{...body.document,approvalId:sent.data.approval.id}},'rep');assert.equal(sale.status,201,JSON.stringify(sale.data));const doc=sale.data.result.document,journal=[...store.journalEntries.values()].find(j=>j.documentId===doc.id);
  const before=store.stockBalances.get(company.id+':'+warehouse.id+':'+item.id).quantity;
  const audit=await request('/api/v1/assistant/workbench/journal',{reference:journal.id});assert.equal(audit.status,200);assert.equal(audit.data.difference,'0.000000');assert.equal(audit.data.findings,0);
  const reconciled=await request('/api/v1/assistant/workbench/reconcile',{reference:doc.id});assert.equal(reconciled.status,200,JSON.stringify(reconciled.data));assert.equal(reconciled.data.findings,0);assert.equal(reconciled.data.outstanding,'176.000000');assert.match(reconciled.data.notice,/تراكمي/);assert.equal(store.stockBalances.get(company.id+':'+warehouse.id+':'+item.id).quantity,before);
  assert.equal((await request('/api/v1/assistant/workbench/reconcile',{reference:doc.id},'blocked')).status,409);assert.equal((await request('/api/v1/assistant/workbench/reconcile',{reference:doc.id},'rep')).status,403);
  store.journalEntries.set(journal.id,{...journal,lines:journal.lines.map((line,index)=>index===0?{...line,debit:'177.000000'}:line)});
  const wrong=await request('/api/v1/assistant/workbench/journal',{reference:journal.id});assert.equal(wrong.data.difference,'1.000000');assert.ok(wrong.data.findings>0);assert.ok((await request('/api/v1/assistant/workbench/reconcile',{reference:doc.id})).data.findings>0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
