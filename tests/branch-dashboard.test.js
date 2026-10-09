import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { installTreasuryRoutes } from '../apps/api/src/modules/treasury/routes.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../apps/api/src/store/memory-store.js';
import { SQLiteStore } from '../apps/api/src/store/sqlite-store.js';
import { PERMISSIONS } from '../apps/api/src/permissions.js';
const at = offset => new Date(Date.now()+offset).toISOString();
async function fixture(store) {
 const company=await store.registerCompany({code:randomUUID(),legalName:'شركة اختبار',timezone:'Asia/Baghdad',currency:'IQD',owner:{username:'owner',displayName:'مدير',passwordHash:'test'}});
 await store.approveCompany(company.id,company.ownerUserId);
 const extra=await store.createBranch(company.id,{code:'B2',name:'فرع اختياري'},company.ownerUserId);
 const context={company:store.companies.get(company.id),user:store.users.get(company.ownerUserId),permissions:PERMISSIONS,scopes:[]};
 const first=await store.createCashbox(context,{code:'C1',name:'الصندوق الأول',currency:'IQD',branchId:company.branches[0].id});
 const second=await store.createCashbox(context,{code:'C2',name:'الصندوق الثاني',currency:'IQD',branchId:extra.id});
 return {context,first,second};
}
test('same currency cashboxes isolate balances and reopening variances',async()=>{
 const store=new MemoryStore();const {context,first,second}=await fixture(store);
 const session=await store.openCashbox(context,first.id,{operationId:randomUUID(),sessionNumber:'A',openingBalance:'100',openedAt:at(-60000)});
 await store.openCashbox(context,second.id,{operationId:randomUUID(),sessionNumber:'B',openingBalance:'200',openedAt:at(-60000)});
 await store.postCashboxMovement(context,first.id,{operationId:randomUUID(),movementNumber:'IN',direction:'in',amount:'25',counterAccountCode:'3000-EQUITY',occurredAt:at(-50000)});
 let boxes=await store.listCashboxes(context.company.id);
 assert.equal(boxes.find(x=>x.id===first.id).openSession.expectedBalance,'125.000000');
 assert.equal(boxes.find(x=>x.id===second.id).openSession.expectedBalance,'200.000000');
 await store.closeCashbox(context,first.id,session.id,{operationId:randomUUID(),countedBalance:'125',closedAt:at(-40000)});
 const reopened=await store.openCashbox(context,first.id,{operationId:randomUUID(),sessionNumber:'C',openingBalance:'130',openedAt:at(-30000)});
 const journal=store.journalEntries.get(reopened.openingJournalId);
 assert.equal(journal.branchId,first.branchId);assert.equal(journal.cashboxId,first.id);
 assert.ok(journal.lines.every(x=>x.cashboxId===first.id));
 boxes=await store.listCashboxes(context.company.id);
 assert.equal(boxes.find(x=>x.id===first.id).openSession.expectedBalance,'130.000000');
 assert.equal(boxes.find(x=>x.id===second.id).openSession.expectedBalance,'200.000000');
});
test('sales post to selected branch cashbox and reject out of scope legacy boxes',async()=>{
 const store=new MemoryStore();const {context,first,second}=await fixture(store);
 await store.openCashbox(context,first.id,{operationId:randomUUID(),sessionNumber:'A',openingBalance:'0',openedAt:at(-60000)});
 await store.openCashbox(context,second.id,{operationId:randomUUID(),sessionNumber:'B',openingBalance:'0',openedAt:at(-60000)});
 const warehouse=await store.createWarehouse(context.company.id,{code:'W',name:'مخزن',branchId:first.branchId},context.user.id);
 const unit=await store.createUnit(context.company.id,{code:'U',name:'قطعة'},context.user.id);
 const item=await store.createItem(context.company.id,{sku:'I',name:'مادة',baseUnitId:unit.id},context.user.id);
 store.stockBalances.set(`${context.company.id}:${warehouse.id}:${item.id}`,{companyId:context.company.id,warehouseId:warehouse.id,itemId:item.id,quantity:'10.000000',averageCost:'2.000000',version:1});
 const payload={documentType:'sale',documentNumber:'S1',branchId:first.branchId,cashboxId:first.id,warehouseId:warehouse.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'1',unitPrice:'10'}],payments:[{method:'cash',amount:'10'}]};
 const operation=(p)=>({operationId:randomUUID(),payloadHash:randomUUID(),type:'commerce.commit',occurredAt:at(-50000),payload:p});
 const [result]=await store.pushOperations(context,[operation(payload)]);
 assert.equal(result.status,'acknowledged',result.message);assert.equal(result.document.branchId,first.branchId);
 const boxes=await store.listCashboxes(context.company.id);
 assert.equal(boxes.find(x=>x.id===first.id).openSession.expectedBalance,'10.000000');
 assert.equal(boxes.find(x=>x.id===second.id).openSession.expectedBalance,'0.000000');
 const legacy=await store.createCashbox(context,{code:'LEGACY',name:'قديم',currency:'IQD'});
 const restricted={...context,scopes:[{type:'branch',id:first.branchId}]};
 const [denied]=await store.pushOperations(restricted,[operation({...payload,documentNumber:'S2',cashboxId:legacy.id})]);
 assert.equal(denied.status,'rejected');assert.equal(denied.code,'BRANCH_SCOPE_DENIED');
 assert.equal(store.commerceDocuments.size,1);
 const [returned]=await store.pushOperations(context,[operation({documentType:'sale_return',documentNumber:'R1',originalDocumentId:result.document.id,warehouseId:warehouse.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,originalLineId:result.document.lines[0].id,quantity:'1'}],payments:[{method:'cash',amount:'10'}]})]);
 assert.equal(returned.status,'acknowledged',returned.message);
 assert.equal(returned.document.cashboxId,first.id);
 assert.equal((await store.listCashboxes(context.company.id)).find(x=>x.id===first.id).openSession.expectedBalance,'0.000000');
 const journal=[...store.journalEntries.values()].find(x=>x.documentId===result.document.id);
 assert.equal(journal.entryNumber,'S1');assert.equal(journal.occurredAt,result.document.occurredAt);
});
test('SQLite keeps cashbox dimensions and balances after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'branch-check-'));let store;
 try {store=new SQLiteStore(join(dir,'test.sqlite'));const {context,first,second}=await fixture(store);
 await store.openCashbox(context,first.id,{operationId:randomUUID(),sessionNumber:'A',openingBalance:'100',openedAt:at(-60000)});
 await store.openCashbox(context,second.id,{operationId:randomUUID(),sessionNumber:'B',openingBalance:'200',openedAt:at(-60000)});
 await store.close();store=new SQLiteStore(join(dir,'test.sqlite'));
 const boxes=await store.listCashboxes(context.company.id);
 assert.equal(boxes.find(x=>x.id===first.id).branchId,first.branchId);
 assert.equal(boxes.find(x=>x.id===first.id).openSession.expectedBalance,'100.000000');
 assert.equal(boxes.find(x=>x.id===second.id).openSession.expectedBalance,'200.000000');
 } finally {if(store)await store.close();rmSync(dir,{recursive:true,force:true});}
});
test('treasury read accepts posting permission and still filters branch scopes',async()=>{
 const store=new MemoryStore();const {context,first}=await fixture(store);const routes=new Map();
 const app={get:(path,...handlers)=>routes.set(path,handlers),post:()=>{}};
 installTreasuryRoutes(app,{store,authenticate:()=>((_req,_res,next)=>next()),permit:()=>((_req,_res,next)=>next()),uuid:x=>x,entityCode:x=>x,decimalInput:x=>x,currency:x=>x});
 const req={auth:{...context,permissions:['accounting.post'],scopes:[{type:'branch',id:first.branchId}]}};
 let output;const res={json:x=>{output=x;}};
 const handlers=routes.get('/api/v1/treasury/cashboxes');
 async function invoke(i){if(i===handlers.length)return;let nextResult;await handlers[i](req,res,error=>{if(error)throw error;nextResult=invoke(i+1);});await nextResult;}
 await invoke(0);assert.deepEqual(output.cashboxes.map(x=>x.id),[first.id]);
 req.auth.permissions=[];await assert.rejects(()=>invoke(0),e=>e.code==='PERMISSION_DENIED');
});
test('branch status button addresses and updates the selected branch',async()=>{
 const source=readFileSync(new URL('../public/enterprise.js',import.meta.url),'utf8');
 const line=source.split('\n').find(x=>x.includes('else if(button.dataset.branchToggle)'));
 const code=line.trim().replace(/^else if/,'if');
 const state={account:{company:{branches:[{id:'b1',active:true},{id:'b2',active:true}]}}};const calls=[];
 await runInNewContext('(async()=>{'+code+'})()',{state,button:{dataset:{branchToggle:'b2',active:'false'}},id:undefined,api:async(path,body,method)=>{calls.push({path,body,method});return {branch:{id:'b2',active:false}};}});
 assert.equal(calls[0].path,'/api/v1/company/branches/b2');assert.equal(calls[0].method,'PATCH');
 assert.equal(state.account.company.branches[0].active,true);assert.equal(state.account.company.branches[1].active,false);
});

