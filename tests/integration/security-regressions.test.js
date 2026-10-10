import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../apps/api/src/app.js';
import {SQLiteStore} from '../../apps/api/src/store/sqlite-store.js';
import {PERMISSIONS} from '../../apps/api/src/permissions.js';
import {hashToken,payloadHash} from '../../apps/api/src/lib/security.js';
import {startBackupService} from '../../apps/api/src/lib/backup-service.js';
import {readdir} from 'node:fs/promises';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'mahasib-security-')),store=new SQLiteStore(join(dir,'state.sqlite'));
 const company={id:randomUUID(),currency:'IQD',branches:[{id:'A',active:true},{id:'B',active:true}]};
 const contexts={admin:{company,user:{id:'admin'},session:{deviceId:'test'},permissions:PERMISSIONS,scopes:[]},sync:{company,user:{id:'sync'},session:{deviceId:'test'},permissions:['sync.use'],scopes:[]},cashier:{company,user:{id:'cashier'},session:{deviceId:'test'},permissions:['sync.use','sales.create','sales.return','pos.shift.open'],scopes:[]},branch:{company,user:{id:'branch'},session:{deviceId:'test'},permissions:PERMISSIONS,scopes:[{type:'branch',id:'A'}]}};
 await store.transaction(()=>store.companies.set(company.id,company));
 const tokens=new Map(Object.entries(contexts).map(([token,context])=>[hashToken(token),context]));store.getSessionContext=async hash=>tokens.get(hash);
 const server=createApp({store}).listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await store.close();await rm(dir,{recursive:true,force:true});});
 const api=async(path,body,token='admin')=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const operation=(type,payload)=>({operationId:randomUUID(),clientSequence:Date.now(),deviceId:'test',type,payload,payloadHash:payloadHash(payload),occurredAt:new Date().toISOString()});
 return {dir,store,contexts,company,api,operation};
}
const item={id:'item',name:'رز',barcode:'123',cost:10,price:20,qty:1,minQty:0,unit:'قطعة'};
test('direct and sync market writes require domain permission and company scope',async t=>{
 const {api,operation,store}=await fixture(t);
 assert.equal((await api('/api/v1/market/snapshot',{catalog:[item]},'sync')).status,403);
 assert.equal((await api('/api/v1/sync/push',{operations:[operation('market.snapshot',{catalog:[item]})]},'sync')).status,403);
 assert.equal((await api('/api/v1/market/snapshot',undefined,'branch')).status,403);
 assert.equal((await api('/api/v1/sync/push',{operations:[operation('market.snapshot',{catalog:[item]})]},'branch')).status,403);
 assert.equal(store.changes.length,0);
});
test('catalog rejects negative, non-finite, duplicate and oversized data without writes',async t=>{
 const {api,operation,store}=await fixture(t);
 for(const catalog of [[{...item,price:-1}],[{...item,qty:'Infinity'}],[item,item],Array.from({length:10001},(_,i)=>({...item,id:String(i),barcode:String(i)}))]){
  assert.equal((await api('/api/v1/market/snapshot',{catalog})).status,400);
  assert.equal((await api('/api/v1/sync/push',{operations:[operation('market.snapshot',{catalog})]})).status,400);
 }
 assert.equal(store.changes.length,0);
});
test('scoped reports and trial balance exclude other branches and unscoped journals',async t=>{
 const {api,store,company}=await fixture(t);
 await store.transaction(()=>{for(const [id,branchId,amount] of [['ja','A','10'],['jb','B','99'],['legacy',null,'77']])store.journalEntries.set(id,{id,companyId:company.id,branchId,status:'posted',occurredAt:new Date().toISOString(),currency:'IQD',lines:[{accountCode:'1000-CASH',debit:amount,credit:'0'},{accountCode:'3000-EQUITY',debit:'0',credit:amount}]});});
 const result=await api('/api/v1/enterprise/reports',undefined,'branch');assert.equal(result.status,200);assert.deepEqual(result.body.journals.map(x=>x.id),['ja']);assert.equal(result.body.trialBalance.find(x=>x.accountCode==='1000-CASH').debit,'10.000000');
});
test('cashier may sell but cannot replace catalog; concurrent tills cannot oversell',async t=>{
 const {api,store}=await fixture(t);
 assert.equal((await api('/api/v1/market/snapshot',{catalog:[item],clientUpdatedAt:'2026-10-10T00:00:00.000Z'})).status,200);
 assert.equal((await api('/api/v1/market/snapshot',{catalog:[item]},'cashier')).status,403);
 const sale=id=>api('/api/v1/market/sale',{id,invoice:id,lines:[{itemId:'item',quantity:1,unitPrice:20}],net:20,cash:20},'cashier');
 const results=await Promise.all([sale('s1'),sale('s2')]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(store.changes.filter(x=>x.entityType==='market.transaction').length,1);assert.equal(store.changes.filter(x=>x.entityType==='market.snapshot').at(-1).payload.catalog[0].qty,0);
});
test('closed periods reject posting atomically, survive backup restore and audited reopening permits posting',async t=>{
 const {api,store,company,dir}=await fixture(t);
 const close=await api('/api/v1/accounting/periods/close',{startDate:'2026-09-01',endDate:'2026-09-30',reason:'مطابقة شهر سبتمبر'});assert.equal(close.status,201);
 const journal={operationId:randomUUID(),entryNumber:'J-CLOSED',occurredAt:'2026-09-20T12:00:00Z',currency:'IQD',lines:[{accountCode:'1000-CASH',debit:'10'},{accountCode:'3000-EQUITY',credit:'10'}]};
 assert.equal((await api('/api/v1/accounting/journals',journal)).status,409);assert.equal(store.journalEntries.size,0);
 const bytes=await store.exportCompanyBackup(company.id);await writeFile(join(dir,'restore.sqlite'),bytes);const restored=new SQLiteStore(join(dir,'restore.sqlite'));assert.equal((await restored.listFinancialPeriods(company.id))[0].status,'closed');await assert.rejects(()=>restored.assertFinancialPeriod(company.id,journal.occurredAt),/الفترة المالية/);await restored.close();
 assert.equal((await api('/api/v1/accounting/periods/'+close.body.period.id+'/reopen',{reason:'تسوية معتمدة'})).status,200);
 assert.equal((await api('/api/v1/accounting/journals',journal)).status,201);
 const audit=await api('/api/v1/audit');assert(audit.body.rows.some(x=>x.action==='financial.period.reopened'&&x.metadata.before.status==='closed'&&x.metadata.after.status==='open'));
});

test('offline market sale deducts stock once and rejects inconsistent totals and excess returns',async t=>{
 const {api,operation,store}=await fixture(t);
 await api('/api/v1/market/snapshot',{catalog:[{...item,qty:5}]});
 const push=async op=>(await api('/api/v1/sync/push',{operations:[op]},'cashier')).body.results[0];
 const invalid=operation('market.transaction.sale',{kind:'sale',id:'bad',invoice:'BAD',net:'1',cash:'1',lines:[{itemId:'item',quantity:'1',unitPrice:'20'}]});assert.equal((await push(invalid)).code,'INVALID_MARKET_TOTAL');
 const sale=operation('market.transaction.sale',{kind:'sale',id:'offline',invoice:'OFF',net:'40',cash:'10',due:'30',lines:[{itemId:'item',quantity:'2',unitPrice:'20'}]});assert.equal((await push(sale)).status,'acknowledged');assert.equal((await push(sale)).status,'acknowledged');assert.equal(store.changes.filter(x=>x.entityType==='market.snapshot').at(-1).payload.catalog[0].qty,3);
 const excess=operation('market.transaction.return',{kind:'return',id:'excess',invoice:'OFF',amount:'60',lines:[{itemId:'item',quantity:'3',unitPrice:'20'}]});assert.equal((await push(excess)).code,'MARKET_RETURN_EXCEEDS_SALE');
 const correct=operation('market.transaction.return',{kind:'return',id:'valid-return',invoice:'OFF',amount:'20',lines:[{itemId:'item',quantity:'1',unitPrice:'20'}]});assert.equal((await push(correct)).status,'acknowledged');assert.equal(store.changes.filter(x=>x.entityType==='market.snapshot').at(-1).payload.catalog[0].qty,4);
 assert.equal(store.changes.filter(x=>x.entityType==='market.transaction'&&x.payload.kind==='sale').length,1);
});

test('raw snapshot sync cannot overwrite a newer catalog without matching its version',async t=>{
 const {api,operation}=await fixture(t);await api('/api/v1/market/snapshot',{catalog:[item]});
 const before=(await api('/api/v1/market/snapshot')).body.snapshot;
 const stale=operation('market.snapshot',{catalog:[{...item,qty:999}]});assert.equal((await api('/api/v1/sync/push',{operations:[stale]})).body.results[0].code,'MARKET_SNAPSHOT_CONFLICT');
 assert.deepEqual((await api('/api/v1/market/snapshot')).body.snapshot,before);
 const valid=operation('market.snapshot',{catalog:[{...item,qty:2}],baseUpdatedAt:before.updatedAt});assert.equal((await api('/api/v1/sync/push',{operations:[valid]})).body.results[0].status,'acknowledged');
 const after=(await api('/api/v1/market/snapshot')).body.snapshot;assert(after.updatedAt>before.updatedAt);assert.equal(after.catalog[0].qty,2);
});

test('restricted sync feed excludes other branch and company-wide market changes',async t=>{
 const {api,store,company}=await fixture(t);
 await store.transaction(()=>{for(const [branchId,id] of [['A','own'],['B','other'],[null,'legacy']])store.changes.push({companyId:company.id,sequence:++store.changeSequence,entityType:'journal_entry',entityId:id,payload:{id,branchId}});store.changes.push({companyId:company.id,sequence:++store.changeSequence,entityType:'market.snapshot',payload:{catalog:[item]}});});
 const result=await api('/api/v1/sync/pull',undefined,'branch');assert.deepEqual(result.body.changes.map(x=>x.entityId),['own']);assert.equal(result.body.nextCursor,4);
});

test('automatic backups verify integrity, retain seven snapshots and restore financial periods',async t=>{
 const {api,store,company,dir}=await fixture(t);await api('/api/v1/accounting/periods/close',{startDate:'2026-08-01',endDate:'2026-08-31',reason:'نسخة استعادة'});
 const directory=join(dir,'backups'),service=startBackupService({store,directory,intervalMs:60000,retain:7});t.after(()=>service.close());let latest;
 for(let i=0;i<9;i++)latest=await service.run();assert.equal((await readdir(directory)).length,7);assert(service.status().lastSuccess);assert.equal(service.status().lastError,null);
 const restored=new SQLiteStore(latest);assert.equal((await restored.listFinancialPeriods(company.id))[0].status,'closed');assert.equal((await restored.listAudit(company.id)).rows[0].action,'financial.period.closed');await restored.close();
});

test('financial closing uses Baghdad business dates and branch admins cannot download full-company backups',async t=>{
 const {api,store,company}=await fixture(t);
 await api('/api/v1/accounting/periods/close',{startDate:'2026-09-01',endDate:'2026-09-30',reason:'توقيت بغداد'});
 await assert.rejects(()=>store.assertFinancialPeriod(company.id,'2026-08-31T22:00:00Z'),/الفترة المالية/);
 await store.assertFinancialPeriod(company.id,'2026-09-30T22:00:00Z');
 assert.equal((await api('/api/v1/enterprise/backup',undefined,'branch')).status,403);
 assert.equal((await api('/api/v1/accounting/periods/close',{startDate:'2026-07-01',endDate:'2026-07-31',reason:'فرع'},'branch')).status,403);
});
