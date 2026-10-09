import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SQLiteStore} from '../../apps/api/src/store/sqlite-store.js';
import {createApp} from '../../apps/api/src/app.js';
import {hashPassword} from '../../apps/api/src/lib/security.js';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';

test('desktop replays offline edits with ID mapping, atomic receipts, conflict retention and restart persistence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'desktop-sync-'));let cloud,server,local;
 try{
  cloud=new SQLiteStore(join(dir,'cloud.sqlite'));
  const password='Offline-Cloud-Test-123';
  const company=await cloud.registerCompany({code:'sync-test',legalName:'شركة المزامنة',currency:'IQD',owner:{username:'owner',displayName:'مدير',passwordHash:await hashPassword(password)}});await cloud.approveCompany(company.id,company.ownerUserId);
  server=await new Promise(resolve=>{const s=createApp({store:cloud}).listen(0,'127.0.0.1',()=>resolve(s));});
  const url='http://127.0.0.1:'+server.address().port;
  local=await startEnterpriseLocal({dataDirectory:join(dir,'local'),port:33385,allowTestCloud:true,protect:x=>x,unprotect:x=>x});
  let token;
  const request=async(path,body,method='POST')=>{const r=await fetch(local.url+path,{method:body?method:'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  let r=await request('/api/local/cloud/connect',{url,companyCode:company.code,username:'owner',password,adopt:true});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(local.store.companies.size,1);assert.ok(local.store.companies.has(company.id));
  r=await request('/api/v1/auth/login',{companyCode:company.code,username:'owner',password});assert.equal(r.status,200);token=r.data.token;
  const unit=(await request('/api/v1/catalog/units',{code:'OFFLINE-U',name:'قطعة'})).data.unit;
  assert.ok(unit?.id);
  const item=(await request('/api/v1/catalog/items',{sku:'OFFLINE-I',name:'بضاعة جديدة',baseUnitId:unit.id,units:[{unitId:unit.id,isBase:true,factorToBase:'1'}]})).data.item;
  assert.ok(item?.id);assert.equal(cloud.items.size,0);
  assert.equal((await request('/api/local/cloud/status')).data.pending,2);
  r=await request('/api/local/cloud/synchronize',{});assert.equal(r.data.state,'complete',JSON.stringify(r.data));assert.equal(r.data.pending,0);
  assert.equal(cloud.items.size,1);const remoteItem=[...cloud.items.values()][0];assert.notEqual(remoteItem.id,item.id);assert.equal(remoteItem.baseUnitId,[...cloud.units.values()][0].id);
  assert.ok(local.store.items.has(remoteItem.id));assert.equal(cloud.desktopCommands.size,2);
  const command=[...local.store.desktopCommands.values()][0];command.transmitted=JSON.parse(Buffer.from(command.transmittedProtected,'base64').toString());const login=await(await fetch(url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:company.code,username:'owner',password})})).json();
  const replay=await fetch(url+'/api/v1/desktop/commands',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify(command.transmitted)});assert.equal(replay.status,200);assert.equal(cloud.units.size,1);
  const changed=await fetch(url+'/api/v1/desktop/commands',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({...command.transmitted,body:{code:'CHANGED',name:'changed'}})});assert.equal(changed.status,409);assert.equal(cloud.units.size,1);
  const warehouse=await cloud.createWarehouse(company.id,{code:'CLOUD-WH',name:'مخزن',branchId:company.branches[0].id},company.ownerUserId);
  const supplier=await cloud.createParty(company.id,'supplier',{code:'SUP',name:'مورد'},company.ownerUserId);
  const customer=await cloud.createParty(company.id,'customer',{code:'CUS',name:'زبون',phone:'07807807491',creditLimit:'10000'},company.ownerUserId);
  assert.equal((await request('/api/local/cloud/synchronize',{})).data.state,'complete');
  const commit=async document=>{const result=await request('/api/v1/commerce/commit',{operationId:randomUUID(),deviceId:'offline-test',clientSequence:Date.now(),occurredAt:new Date().toISOString(),document});assert.equal(result.status,201,JSON.stringify(result.data));return result.data.result.document;};
  const base={warehouseId:warehouse.id,branchId:company.branches[0].id,currency:'IQD',payments:[]};
  await commit({...base,documentType:'purchase',documentNumber:'OFFLINE-P1',partyId:supplier.id,lines:[{itemId:remoteItem.id,unitId:remoteItem.baseUnitId,quantity:'10',unitPrice:'20'}]});
  const sale=await commit({...base,documentType:'sale',documentNumber:'OFFLINE-S1',partyId:customer.id,lines:[{itemId:remoteItem.id,unitId:remoteItem.baseUnitId,quantity:'2',unitPrice:'50'}]});
  const payment=await request('/api/v1/enterprise/settlements',{operationId:randomUUID(),receiptNumber:'OFFLINE-R1',documentId:sale.id,amount:'20',receivedAmount:'20',receivedCurrency:'IQD',method:'cash',occurredAt:new Date().toISOString()});assert.equal(payment.status,201,JSON.stringify(payment.data));
  assert.equal(cloud.commerceDocuments.size,0);assert.equal(local.store.journalEntries.size,3);
  const originalFetch=globalThis.fetch;let lost=false;globalThis.fetch=async(input,options)=>{const response=await originalFetch(input,options);if(!lost&&String(input)===url+'/api/v1/desktop/commands'&&JSON.parse(options.body).path==='/api/v1/enterprise/settlements'){lost=true;await response.text();return new Response('lost acknowledgement',{status:200});}return response;};
  try{assert.equal((await request('/api/local/cloud/synchronize',{})).data.state,'failed');}finally{globalThis.fetch=originalFetch;}
  assert.equal(cloud.journalEntries.size,3);assert.equal((await request('/api/local/cloud/status')).data.pending,1);
  assert.equal((await request('/api/local/cloud/synchronize',{})).data.state,'complete');
  assert.equal(cloud.commerceDocuments.size,2);assert.equal(cloud.journalEntries.size,3);assert.equal(cloud.customerNotifications.size,1);
  assert.equal([...cloud.stockBalances.values()][0].quantity,'8.000000');
  const financial=[...local.store.desktopCommands.values()].filter(x=>x.path==='/api/v1/commerce/commit'||x.path==='/api/v1/enterprise/settlements');
  for(const c of financial){const replay=await fetch(url+'/api/v1/desktop/commands',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:Buffer.from(c.transmittedProtected,'base64').toString()});assert.equal(replay.status,200);}
  assert.equal(cloud.journalEntries.size,3);assert.equal(cloud.customerNotifications.size,1);assert.equal([...cloud.stockBalances.values()][0].quantity,'8.000000');
  // A central edit colliding with a valid offline edit cannot overwrite either database.
  const id=randomUUID();await cloud.createUnit(company.id,{code:'CONFLICT',name:'سحابي'},company.ownerUserId);
  assert.equal((await request('/api/v1/catalog/units',{code:'CONFLICT',name:'محلي'})).status,201);
  r=await request('/api/local/cloud/synchronize',{});assert.equal(r.data.state,'failed');assert.equal(r.data.conflicts,1);assert.ok([...local.store.units.values()].some(x=>x.name==='محلي'));
  await local.close();local=null;
  local=await startEnterpriseLocal({dataDirectory:join(dir,'local'),port:33385,allowTestCloud:true,protect:x=>x,unprotect:x=>x});
  assert.equal((await request('/api/local/cloud/status')).data.conflicts,1);assert.ok(local.store.desktopCommands.size>=3);
 }finally{await local?.close();if(server)await new Promise(resolve=>server.close(resolve));await cloud?.close();await rm(dir,{recursive:true,force:true});}
});
