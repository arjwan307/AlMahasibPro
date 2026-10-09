import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteStore} from '../apps/api/src/store/sqlite-store.js';
import {PERMISSIONS} from '../apps/api/src/permissions.js';
import {whatsappPhone} from '../apps/api/src/lib/customer-notifications.js';
import {notificationContacts} from '../apps/api/src/modules/notifications/routes.js';

test('receipt replay creates one journal and one notification; backup isolates company and embeds photos',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'notifications-backup-'));let store,restored;
 try{
  store=new SQLiteStore(join(dir,'data.sqlite'));
  const company=await store.registerCompany({code:'test',legalName:'شركة',currency:'IQD',owner:{username:'owner',displayName:'مدير',passwordHash:'test'}});await store.approveCompany(company.id,company.ownerUserId);
  const other=await store.registerCompany({code:'other',legalName:'شركة أخرى',currency:'IQD',owner:{username:'other',displayName:'آخر',passwordHash:'private-secret'}});
  const context={company:store.companies.get(company.id),user:store.users.get(company.ownerUserId),permissions:PERMISSIONS,scopes:[]};
  const unit=await store.createUnit(company.id,{code:'U1',name:'قطعة'},context.user.id),item=await store.createItem(company.id,{sku:'I1',name:'مادة',baseUnitId:unit.id},context.user.id),warehouse=await store.createWarehouse(company.id,{code:'W1',name:'مخزن',branchId:company.branches[0].id},context.user.id),customer=await store.createParty(company.id,'customer',{code:'C1',name:'زبون',phone:'٠٧٨٠٧٨٠٧٤٩١',creditLimit:'1000'},context.user.id);
  store.stockBalances.set(`${company.id}:${warehouse.id}:${item.id}`,{companyId:company.id,warehouseId:warehouse.id,itemId:item.id,quantity:'10.000000',averageCost:'2.000000',version:1});
  const op={operationId:randomUUID(),type:'commerce.commit',payloadHash:'sale-one',occurredAt:new Date().toISOString(),payload:{documentType:'sale',documentNumber:'S1',warehouseId:warehouse.id,branchId:company.branches[0].id,partyId:customer.id,currency:'IQD',lines:[{itemId:item.id,unitId:unit.id,quantity:'2',unitPrice:'50'}],payments:[]}};
  const [result]=await store.pushOperations(context,[op]);assert.equal(result.status,'acknowledged',result.message);
  const payment={operationId:randomUUID(),receiptNumber:'R1',documentId:result.document.id,receivedAmount:'20',receivedCurrency:'IQD',method:'cash',occurredAt:new Date().toISOString()};
  const first=await store.settleEnterpriseDocument(context,payment),again=await store.settleEnterpriseDocument(context,payment);assert.equal(first.id,again.id);assert.equal(store.customerNotifications.size,1);assert.equal(store.journalEntries.size,2);
  const message=[...store.customerNotifications.values()][0];assert.equal(message.phone,'9647807807491');assert.match(message.text,/20\.000000 IQD/);assert.equal(message.status,'draft');
  await assert.rejects(()=>store.settleEnterpriseDocument(context,{...payment,receivedAmount:'21'}),e=>e.code==='OPERATION_ID_REUSED');assert.equal(store.customerNotifications.size,1);
  const manual={operationId:randomUUID(),recipientType:'other',recipientName:'جهة أخرى',phone:'9647807807491',type:'general',text:'تذكير'};
  const draft=await store.prepareCustomerNotification(company.id,manual,context.user.id);await store.prepareCustomerNotification(company.id,manual,context.user.id);assert.equal(store.customerNotifications.size,2);
  await store.markCustomerNotificationOpened(company.id,draft.id,context.user.id);assert.equal(store.customerNotifications.get(draft.id).status,'draft');
  const contacts=notificationContacts(store,company.id);assert.ok(contacts.some(x=>x.type==='customer'));assert.ok(contacts.some(x=>x.type==='user'));assert.ok(!contacts.some(x=>x.id===other.ownerUserId));
  await mkdir(join(dir,'item-photos'));await writeFile(join(dir,'item-photos','test.png'),Buffer.from([137,80,78,71,13,10,26,10]));
  await store.saveSalesSetting('item:'+item.id,{companyId:company.id,photos:[{id:'photo',filename:'test.png',mime:'image/png'}]},context.user.id);
  store.sessions.set('session',{companyId:company.id,userId:context.user.id});
  const backup=await store.exportCompanyBackup(company.id);await writeFile(join(dir,'backup.sqlite'),backup);restored=new SQLiteStore(join(dir,'backup.sqlite'));
  assert.equal(restored.companies.size,1);assert.ok(restored.companies.has(company.id));assert.ok(!restored.users.has(other.ownerUserId));assert.equal(restored.sessions.size,0);assert.equal(restored.customerNotifications.size,2);assert.ok(restored.salesSettings.get('item:'+item.id).photos[0].data.startsWith('data:image/png;base64,'));assert.equal(restored.commerceDocuments.size,1);
 }finally{await restored?.close();await store?.close();await rm(dir,{recursive:true,force:true});}
});
test('WhatsApp phone accepts Iraqi and international numbers and rejects malformed recipients',()=>{
 assert.equal(whatsappPhone('٠٧٨٠٧٨٠٧٤٩١'),'9647807807491');assert.equal(whatsappPhone('+964 780 780 7491'),'9647807807491');assert.equal(whatsappPhone('00964 7807807491'),'9647807807491');assert.throws(()=>whatsappPhone('not-a-number'));
});
