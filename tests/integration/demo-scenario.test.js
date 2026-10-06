import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseCloud} from '../../apps/api/src/cloud-server.js';
import {demoWholesaleCustomers} from '../../apps/api/src/demo-wholesale-customers.js';
import {furnitureCatalog} from '../../apps/api/src/furniture-catalog.js';

test('demo scenario upgrades existing balances and stock atomically, preserves entries and applies once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'demo-scenario-'));let rt;const opts={dataDirectory:dir,setupToken:'scenario-key-12345678901234567890',origin:'https://example.test',port:0};
 try{
 rt=await startEnterpriseCloud(opts);const setup=await fetch(rt.url+'/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupToken:opts.setupToken,legalName:'شركة تجربة',ownerName:'مدير',username:'admin',password:'Strong-Password-123'})});assert.equal(setup.status,201);
 const company=[...rt.store.companies.values()][0],catalog=demoWholesaleCustomers(),furniture=furnitureCatalog();const legacy=structuredClone(catalog);legacy.customers.forEach((x,i)=>{x.balance=i<90?0:i<147?25+(i-90)%12*25:-[50,75,100][i-147];x.paymentPreference=x.balance>0?'credit':'cash';});const oldFurniture=structuredClone(furniture);oldFurniture.items.forEach(x=>x.quantity=0);
 await rt.store.importDemoWholesaleCustomers(company.id,company.ownerUserId,legacy);await rt.store.importFurnitureCatalog(company.id,company.ownerUserId,oldFurniture);const oldJournals=[...rt.store.journalEntries.keys()];
 const marker=()=>writeFile(join(dir,'demo-scenario-request.json'),JSON.stringify({companyCode:'company',version:'demo-scenario-v2'}));await rt.close();await marker();rt=await startEnterpriseCloud(opts);
 const result=JSON.parse(await readFile(join(dir,'demo-scenario-result.json'),'utf8'));assert.equal(result.cashCustomers,20);assert.equal(result.debitCustomers,127);assert.equal(result.creditCustomers,3);assert.equal(result.inactive,30);assert.equal(result.sporadic,60);assert.equal(result.active,60);assert.equal(result.small,100);assert.equal(result.large,50);assert.equal(result.itemsUpdated,252);
 for(const c of rt.store.customers.values()){const expected=catalog.customers.find(x=>x.code===c.code);assert.equal(Number(c.openingBalances[0].amount),expected.balance);assert.equal(c.demoPurchaseHistory.length,3);const debt=[...rt.store.debtMovements.values()].filter(x=>x.customerId===c.id&&x.currency==='USD').reduce((s,x)=>s+Number(x.amount),0);assert.equal(debt,expected.balance);}
 for(const d of furniture.items){const item=[...rt.store.items.values()].find(x=>x.sku===d.sku),stock=[...rt.store.stockBalances.values()].find(x=>x.itemId===item.id);assert.equal(Number(stock.quantity),d.quantity);if(d.warehouseCode==='FUR-ROOMS')assert.equal(d.quantity,20);if(d.warehouseCode==='FUR-SOFAS')assert(d.quantity>=10);if(d.metadata.category==='ميز طعام')assert(d.quantity>=25);}
 assert(oldJournals.every(id=>rt.store.journalEntries.has(id)));assert([...rt.store.journalEntries.values()].every(j=>j.lines.reduce((s,l)=>s+Number(l.debit)-Number(l.credit),0)===0));assert.equal(rt.store.commerceDocuments.size,0);
 const count=rt.store.journalEntries.size;await rt.close();await marker();rt=await startEnterpriseCloud(opts);const repeat=JSON.parse(await readFile(join(dir,'demo-scenario-result.json'),'utf8'));assert.equal(repeat.alreadyApplied,true);assert.equal(rt.store.journalEntries.size,count);
 }finally{await rt?.close();await rm(dir,{recursive:true,force:true});}
});
