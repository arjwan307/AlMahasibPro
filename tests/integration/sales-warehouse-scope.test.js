import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {MemoryStore} from '../../apps/api/src/store/memory-store.js';
import {hashToken} from '../../apps/api/src/lib/security.js';
import {PERMISSIONS,ROLE_TEMPLATES} from '../../apps/api/src/permissions.js';

test('sales reads, approvals and offline replay enforce warehouse scopes before any accounting or stock write',async()=>{
 const store=new MemoryStore();
 const company=await store.registerCompany({code:'scoped-sales',legalName:'Scope test',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'admin',displayName:'Admin',passwordHash:'test'}});
 await store.approveCompany(company.id,company.ownerUserId);
 const owner=store.users.get(company.ownerUserId),seller=await store.createUser(company.id,{username:'seller',displayName:'Seller',roleCode:'representative',passwordHash:'test'},owner.id);
 const unit=await store.createUnit(company.id,{code:'PC',name:'Piece',decimalPlaces:6},owner.id),item=await store.createItem(company.id,{sku:'A',name:'Item',baseUnitId:unit.id},owner.id);
 const allowed=await store.createWarehouse(company.id,{code:'A',name:'Allowed'},owner.id),blocked=await store.createWarehouse(company.id,{code:'B',name:'Blocked'},owner.id),customer=await store.createParty(company.id,'customer',{code:'C',name:'Customer',creditLimit:'1000'},owner.id);
 for(const w of [allowed,blocked])store.stockBalances.set(company.id+':'+w.id+':'+item.id,{companyId:company.id,warehouseId:w.id,itemId:item.id,quantity:'10.000000',averageCost:'2.000000',version:1});
 const id=randomUUID();store.prices.set(id,{id,companyId:company.id,itemId:item.id,unitId:unit.id,priceType:'sale_retail',amount:'10',currency:'IQD',active:true});
 const session={expiresAt:new Date(Date.now()+86400000).toISOString(),deviceId:'scope-test'};
 const admin={company,user:owner,permissions:PERMISSIONS,roles:[],scopes:[],session};
 const rep={company,user:seller,permissions:ROLE_TEMPLATES.representative,roles:[{code:'representative'}],scopes:[{type:'warehouse',id:allowed.id}],session};
 const unrestricted={...rep,scopes:[]};
 store.getSessionContext=async token=>token===hashToken('rep')?rep:token===hashToken('unrestricted')?unrestricted:token===hashToken('scoped-admin')?{...admin,scopes:rep.scopes}:admin;
 const server=createApp({store}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,body,token='rep')=>{const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
 const document=w=>({documentType:'sale',documentNumber:'S-'+randomUUID(),warehouseId:w.id,partyId:customer.id,currency:'IQD',discountAmount:'0',lines:[{itemId:item.id,unitId:unit.id,quantity:'1',unitPrice:'10'}],payments:[],delivery:{mode:'immediate'}});
 const operation=doc=>({operationId:randomUUID(),deviceId:'scope-test',clientSequence:1,occurredAt:new Date().toISOString(),schemaVersion:1,type:'commerce.commit',payload:doc});
 try{
  const own=await request('/api/v1/sales/approvals',{document:document(allowed)}),other=await request('/api/v1/sales/approvals',{document:document(blocked)},'unrestricted');assert.equal(own.status,201);assert.equal(other.status,201);
  const boot=await request('/api/v1/sales/bootstrap');assert.deepEqual(boot.data.warehouses.map(w=>w.id),[allowed.id]);assert.deepEqual(boot.data.stock.map(w=>w.warehouseId),[allowed.id]);assert.deepEqual(boot.data.approvals.map(a=>a.id),[own.data.approval.id]);
  assert.equal((await request('/api/v1/sales/approvals/'+other.data.approval.id+'/decision',{status:'approved'},'scoped-admin')).status,403);
  await store.saveSalesSetting('item:'+item.id,{companyId:company.id,reserved:{[allowed.id]:'1',[blocked.id]:'7'}},owner.id);
  assert.deepEqual((await request('/api/v1/sales/bootstrap')).data.items[0].reserved,{[allowed.id]:'1'});
  const reservation=await request('/api/v1/sales/reservations',{document:document(blocked),expiresAt:new Date(Date.now()+3600000).toISOString()},'unrestricted');assert.equal(reservation.status,201);
  assert.equal((await request('/api/v1/sales/bootstrap')).data.reservations.length,0);
  const cancellation=await fetch(base+'/api/v1/sales/reservations/'+reservation.data.reservation.id,{method:'DELETE',headers:{Authorization:'Bearer rep'}});assert.equal(cancellation.status,403);
  const foreign=document(blocked);assert.equal((await request('/api/v1/sales/approvals',{document:foreign})).status,403);
  const mixed={...document(allowed),lines:[{itemId:item.id,unitId:unit.id,quantity:'1',unitPrice:'10',warehouseId:blocked.id}]};
  assert.equal((await request('/api/v1/sales/approvals',{document:mixed})).status,403);
  assert.equal((await request('/api/v1/sales/reservations',{document:mixed,expiresAt:new Date(Date.now()+3600000).toISOString()})).status,403);
  for(const doc of [foreign,mixed]){
   const op=operation(doc),direct=await request('/api/v1/commerce/commit',{...op,document:doc});assert.equal(direct.status,403);
   const replay=await request('/api/v1/sync/push',{operations:[op]});assert.equal(replay.status,200);assert.equal(replay.data.results[0].status,'rejected');assert.equal(replay.data.results[0].code,'WAREHOUSE_SCOPE_DENIED');
  }
  assert.equal(store.commerceDocuments.size,0);assert.equal(store.journalEntries.size,0);assert.equal(store.stockBalances.get(company.id+':'+blocked.id+':'+item.id).quantity,'10.000000');
  const validDoc=document(allowed),approval=await request('/api/v1/sales/approvals',{document:validDoc});await request('/api/v1/sales/approvals/'+approval.data.approval.id+'/decision',{status:'approved'},'admin');const valid=operation({...validDoc,approvalId:approval.data.approval.id});const posted=await request('/api/v1/sync/push',{operations:[valid]});assert.equal(posted.data.results[0].status,'rejected');assert.equal(posted.data.results[0].code,'MANAGER_POST_REQUIRED');const managerPosted=await request('/api/v1/sales/approvals/'+approval.data.approval.id+'/decision',{status:'approved',post:true},'admin');assert.equal(managerPosted.status,200);
  const repeated=await request('/api/v1/sync/push',{operations:[valid]});assert.equal(repeated.data.results[0].status,'rejected');assert.equal(store.commerceDocuments.size,1);assert.equal(store.stockBalances.get(company.id+':'+allowed.id+':'+item.id).quantity,'9.000000');
  for(const doc of [document(blocked),mixed]){const op=operation(doc);assert.equal((await request('/api/v1/commerce/commit',{...op,document:doc},'admin')).status,201);}
  assert.equal((await request('/api/v1/commerce/documents')).data.documents.length,1);
  assert.equal((await request('/api/v1/sales/bootstrap')).data.documents.length,1);
  const adminChanges=await request('/api/v1/sync/pull?cursor=0',null,'scoped-admin');assert.equal(adminChanges.data.changes.filter(x=>x.entityType==='commerce_document').length,1);
  const changes=await request('/api/v1/sync/pull?cursor=0');assert.ok(!changes.data.changes.some(x=>x.payload?.warehouseId===blocked.id));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
