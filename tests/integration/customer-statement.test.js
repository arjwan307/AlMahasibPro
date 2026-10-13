import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {createApp} from '../../apps/api/src/app.js';
import {PERMISSIONS} from '../../apps/api/src/permissions.js';
import {customerStatement,DEFAULT_STATEMENT_FIELDS} from '../../apps/api/src/customer-statement.js';

test('customer statement includes every purchase, lines, loading, returns and payments; edits persist and Excel hides selected fields',async()=>{
 const store=new MemoryStore(),company=await store.registerCompany({code:'statement',legalName:'شركة الكشف',currency:'IQD',owner:{username:'owner',displayName:'مدير',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
 const owner=store.users.get(company.ownerUserId),context={company,user:owner,permissions:PERMISSIONS,roles:[],scopes:[]},unit=await store.createUnit(company.id,{code:'PC',name:'قطعة'},owner.id),item=await store.createItem(company.id,{sku:'ITEM',name:'المادة',baseUnitId:unit.id},owner.id),warehouse=await store.createWarehouse(company.id,{code:'WH',name:'المعرض'},owner.id),otherWarehouse=await store.createWarehouse(company.id,{code:'OTHER',name:'المعرض الثاني'},owner.id),customer=await store.createParty(company.id,'customer',{code:'C',name:'الزبون',phone:'077123',salesChannel:'wholesale'},owner.id);
 store.customers.set(customer.id,{...customer,openingBalances:[{currency:'IQD',amount:'10',occurredAt:'2026-10-01'}]});
 const line=(quantity,unitPrice)=>({id:randomUUID(),itemId:item.id,unitId:unit.id,quantity,unitPrice,baseQuantity:quantity});
 const doc=(type,number,lines,discount,paid,at,w=warehouse)=>({id:randomUUID(),companyId:company.id,customerId:customer.id,documentType:type,documentNumber:number,warehouseId:w.id,branchId:company.branches[0].id,currency:'IQD',lines,discountAmount:discount,paidAmount:paid,occurredAt:at});
 const first=doc('sale','S1',[line('3','20'),line('2','20')],'10','30','2026-10-10T10:00:00Z'),second=doc('sale','S2',[line('1','50')],'0','0','2026-10-11T10:00:00Z',otherWarehouse),returned=doc('sale_return','R1',[line('1','20')],'0','0','2026-10-12T10:00:00Z');
 for(const d of [first,second,returned])store.commerceDocuments.set(d.id,d);
 const payment={id:randomUUID(),companyId:company.id,kind:'enterprise_settlement',documentId:first.id,customerId:customer.id,receiptNumber:'PAY1',amount:'25',totalDocumentAmount:'25',currency:'IQD',occurredAt:'2026-10-12T12:00:00Z'};store.financialRecords.set(payment.id,payment);
 const load={id:randomUUID(),companyId:company.id,documentId:first.id,loadedAt:'2026-10-12T11:00:00Z',lines:[{originalLineId:first.lines[0].id,quantity:'2'}]};store.deliveryLoads.set(load.id,load);
 await store.saveSalesSetting('invoice-design:'+company.id,{companyId:company.id,englishName:'TEST COMPANY',address:'بغداد',representatives:'مندوب — 077123'},owner.id);const statement=await customerStatement(store,context,customer.id);assert.deepEqual(statement.columns.filter(c=>!statement.hiddenColumns.includes(c.key)).map(c=>c.key),DEFAULT_STATEMENT_FIELDS);assert.equal(statement.branding.englishName,'TEST COMPANY');assert.equal(statement.rows.length,6);assert.equal(statement.summary[0].required,'75.000000');assert.equal(statement.rows.find(r=>r.documentId===first.id).loadDate,'2026-10-12');assert.equal(statement.rows[1].phone,'077123');assert.equal(statement.rows[1].lastPayment,'2026-10-12');assert.ok(statement.rows.every((r,i)=>r.sequence===i+1));
 const scoped=await customerStatement(store,{...context,scopes:[{type:'warehouse',id:warehouse.id}]},customer.id);assert.ok(!scoped.rows.some(r=>r.documentId===second.id||r.invoice==='رصيد افتتاحي'));
 store.getSessionContext=async()=>context;const server=createApp({store}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,body,method='POST')=>fetch(base+path,{method,headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const row=statement.rows.find(r=>r.documentId===second.id),saved=await request('/api/v1/customers/'+customer.id+'/statement',{revision:0,hiddenColumns:['phone','loadDate'],overrides:{[row.id]:{name:'اسم معدل',phone:'077999',showroom:'معرض معدل',net:'60',note:'مراجعة'}}},'PUT');assert.equal(saved.status,200,await saved.clone().text());const updated=await saved.json();assert.equal(updated.revision,1);assert.equal(updated.summary[0].required,'85.000000');assert.equal(updated.rows.find(r=>r.id===row.id).name,'اسم معدل');assert.equal(store.commerceDocuments.get(second.id).lines[0].unitPrice,'50');
  assert.equal((await request('/api/v1/customers/'+customer.id+'/statement',{revision:0,overrides:{}},'PUT')).status,409);
  const response=await request('/api/v1/customers/'+customer.id+'/statement/export',{});assert.equal(response.status,200);const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));const sheet=workbook.getWorksheet('كشف الزبون');assert.equal(sheet.getColumn(statement.columns.findIndex(c=>c.key==='phone')+1).hidden,true);assert.equal(sheet.getColumn(statement.columns.findIndex(c=>c.key==='loadDate')+1).hidden,true);assert.equal(workbook.getWorksheet('ملخص الحساب').getCell('E3').value.result,85);
  context.permissions=['sales.read'];assert.equal((await request('/api/v1/customers/'+customer.id+'/statement',{revision:1,overrides:{}},'PUT')).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('all sellers, including administrators, must have stock and a registered positive sale price',async()=>{
 const store=new MemoryStore(),company=await store.registerCompany({code:'price',legalName:'Price',currency:'IQD',owner:{username:'owner',displayName:'Owner',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
 const owner=store.users.get(company.ownerUserId),context={company,user:owner,permissions:PERMISSIONS,roles:[],scopes:[]},unit=await store.createUnit(company.id,{code:'PC',name:'Piece'},owner.id),item=await store.createItem(company.id,{sku:'A',name:'Item',baseUnitId:unit.id},owner.id),warehouse=await store.createWarehouse(company.id,{code:'WH',name:'Warehouse'},owner.id);
 const payload={documentType:'sale',documentNumber:'S1',warehouseId:warehouse.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'1',unitPrice:'10'}],payments:[{method:'cash',amount:'10'}]},commit=async()=>{const [result]=await store.pushOperations(context,[{operationId:randomUUID(),payloadHash:randomUUID(),type:'commerce.commit',occurredAt:new Date().toISOString(),payload}]);return result;};
 assert.equal((await commit()).code,'INSUFFICIENT_STOCK');store.stockBalances.set(company.id+':'+warehouse.id+':'+item.id,{companyId:company.id,warehouseId:warehouse.id,itemId:item.id,quantity:'2',averageCost:'2',version:1});assert.equal((await commit()).code,'PRICE_REQUIRED');assert.equal(store.journalEntries.size,0);
 const price=await store.setPrice(company.id,{itemId:item.id,unitId:unit.id,priceType:'sale',currency:'IQD',amount:'0'},owner.id);assert.equal((await commit()).code,'PRICE_REQUIRED');store.prices.set(price.id,{...price,amount:'10'});assert.equal((await commit()).status,'acknowledged');assert.equal(store.commerceDocuments.size,1);
});
