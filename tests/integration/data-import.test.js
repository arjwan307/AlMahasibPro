import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { SQLiteStore } from '../../apps/api/src/store/sqlite-store.js';
import { normalizeImportRows } from '../../apps/api/src/modules/data-import/plan.js';
import { readImportSource } from '../../apps/api/src/modules/data-import/sources.js';
import { createApp } from '../../apps/api/src/app.js';
import { hashToken } from '../../apps/api/src/lib/security.js';

const permissions=['company.manage','customers.manage','suppliers.manage','catalog.manage','accounting.post'];
const mapping={code:'code',name:'name',phone:'phone',openingBalance:'openingBalance',currency:'currency'};
const rows=[{code:'A',name:'عميل أول',phone:'123',openingBalance:'10.125',currency:'USD'},{code:'B',name:'عميل ثان',phone:'456',openingBalance:'-2',currency:'USD'}];
const encode=content=>Buffer.from(content).toString('base64');
const rejectCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);
async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'data-import-test-')),filename=join(directory,'target.sqlite'),store=new SQLiteStore(filename);
  const company={id:randomUUID(),currency:'IQD',status:'active',branches:[{id:randomUUID(),active:true}]},user={id:randomUUID(),companyId:company.id,status:'active',scopes:[]},context={company,user,scopes:[],permissions};
  await store.transaction(()=>{store.companies.set(company.id,company);store.users.set(user.id,user);});
  const input={entity:'customers',branchId:company.branches[0].id,openingDate:'2026-10-10',expectedBalances:{USD:{net:'8.125',debit:'10.125',credit:'2'}},rows:normalizeImportRows('customers',rows,mapping)};
  return {store,filename,context,input,directory,async close(){await this.store.close();await rm(directory,{recursive:true,force:true});}};
}
test('CSV, Excel and SQLite adapters return the same plain rows and reject unsafe sources',async()=>{
  const csv='code,name,phone,openingBalance,currency\r\nA,"عميل أول",123,10.125,USD\r\nB,عميل ثان,456,-2,USD';
  assert.deepEqual(await readImportSource({format:'csv',content:encode(csv)}),rows);
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('customers');sheet.addRow(Object.keys(rows[0]));rows.forEach(row=>sheet.addRow(Object.values(row)));
  assert.deepEqual(await readImportSource({format:'xlsx',sheet:'customers',content:encode(await book.xlsx.writeBuffer())}),rows);
  sheet.getCell('D2').value={formula:'1+1',result:2};
  await rejectCode(readImportSource({format:'xlsx',content:encode(await book.xlsx.writeBuffer())}),'INVALID_SOURCE');
  const directory=await mkdtemp(join(tmpdir(),'source-import-test-')),filename=join(directory,'source.sqlite');
  try {
    const db=new DatabaseSync(filename);db.exec('CREATE TABLE customers(code TEXT,name TEXT,phone TEXT,openingBalance TEXT,currency TEXT); CREATE VIEW unsafe AS SELECT * FROM customers;');
    const insert=db.prepare('INSERT INTO customers VALUES(?,?,?,?,?)');rows.forEach(row=>insert.run(...Object.values(row)));db.close();
    const content=encode(await readFile(filename));
    assert.deepEqual(await readImportSource({format:'sqlite',table:'customers',content}),rows);
    await rejectCode(readImportSource({format:'sqlite',table:'unsafe',content}),'INVALID_SOURCE');
    await rejectCode(readImportSource({format:'sqlite',table:'customers; DROP TABLE customers',content}),'INVALID_SOURCE');
  } finally {await rm(directory,{recursive:true,force:true});}
  await rejectCode(readImportSource({format:'csv',content:encode('code,code\nA,B')}),'INVALID_SOURCE');
  await rejectCode(readImportSource({format:'csv',content:encode('code,name\n'+Array(5001).fill('A,B').join('\n'))}),'INVALID_SOURCE');
  await rejectCode(readImportSource({format:'xls',content:''}),'UNSUPPORTED_SOURCE');
  await rejectCode(readImportSource({format:'mysql',name:'unknown'},{companyId:'x',branchId:'y'}),'SOURCE_NOT_ALLOWED');
  assert.throws(()=>normalizeImportRows('customers',[{...rows[0],companyId:'other'}],mapping),error=>error.code==='SOURCE_IDENTITY_FORBIDDEN');
  assert.throws(()=>normalizeImportRows('customers',[{...rows[0],openingBalance:'1,000'}],mapping),error=>error.code==='INVALID_AMOUNT');
});
test('atomic approval reconciles exact amounts, isolates companies and survives retries and restart',async()=>{
  const f=await fixture();
  try {
    f.store.customers.set('other',{id:'other',companyId:'foreign-company',code:'A',phone:'123'});
    const preview=await f.store.createDataImportPreview(f.context,f.input);
    assert.equal(preview.canCommit,true);assert.equal(preview.balances.USD.net,'8.125000');assert.equal(f.store.customers.size,1);
    const [result,retry]=await Promise.all([f.store.commitDataImport(f.context,preview.id,preview.hash),f.store.commitDataImport(f.context,preview.id,preview.hash)]);
    assert.deepEqual(result,retry);assert.equal(result.created,2);assert.equal(f.store.journalEntries.size,2);
    await rejectCode(f.store.deleteCustomer(f.context.company.id,result.ids[0],f.context.user.id),'CUSTOMER_HAS_HISTORY');
    await rejectCode(f.store.reverseJournal(f.context,result.journalIds[0],{}),'IMPORT_REVERSAL_REQUIRED');
    for(const journal of f.store.journalEntries.values()){assert.equal(journal.branchId,f.input.branchId);assert.equal(journal.companyId,f.context.company.id);assert.ok(journal.partyId);assert.equal(journal.lines.reduce((n,line)=>n+Number(line.debit)-Number(line.credit),0),0);}
    assert.equal(f.store.debtMovements.size,2);
    const mismatch=await f.store.createDataImportPreview(f.context,{...f.input,expectedBalances:{USD:{net:'0',debit:'0',credit:'0'}}});assert.equal(mismatch.canCommit,false);
    await rejectCode(f.store.commitDataImport(f.context,mismatch.id,mismatch.hash),'IMPORT_CONFLICT');
    await rejectCode(f.store.commitDataImport({...f.context,company:{id:'foreign-company'}},preview.id,preview.hash),'IMPORT_NOT_FOUND');
    await rejectCode(f.store.commitDataImport(f.context,preview.id,'0'.repeat(64)),'IMPORT_APPROVAL_MISMATCH');
    await f.store.close();f.store=new SQLiteStore(f.filename);
    assert.deepEqual(await f.store.commitDataImport(f.context,preview.id,preview.hash),result);assert.equal(f.store.customers.size,3);
  }finally{await f.close();}
});
test('rollback, stale previews, expiry, branch scope and permission revocation block writes',async()=>{
  const f=await fixture();try{
    await rejectCode(f.store.createDataImportPreview({...f.context,scopes:[{type:'branch',id:f.input.branchId}]},f.input),'IMPORT_SCOPE_DENIED');
    await rejectCode(f.store.createDataImportPreview(f.context,{...f.input,branchId:randomUUID()}),'BRANCH_NOT_FOUND');
    const preview=await f.store.createDataImportPreview(f.context,f.input),createParty=f.store.createParty;let calls=0;
    f.store.createParty=async(...args)=>{if(++calls===2)throw Error('injected failure');return createParty(...args);};
    await assert.rejects(f.store.commitDataImport(f.context,preview.id,preview.hash),/injected failure/);
    assert.equal(f.store.customers.size,0);assert.equal(f.store.journalEntries.size,0);assert.equal(f.store.debtMovements.size,0);assert.equal(f.store.dataImportBatches.get(preview.id).status,'preview');
    f.store.createParty=createParty;
    await rejectCode(f.store.commitDataImport({...f.context,permissions:permissions.filter(p=>p!=='accounting.post')},preview.id,preview.hash),'PERMISSION_DENIED');
    await f.store.createParty(f.context.company.id,'customer',{code:'A',name:'concurrent'},f.context.user.id);
    await rejectCode(f.store.commitDataImport(f.context,preview.id,preview.hash),'IMPORT_CONFLICT');
    const expired=await f.store.createDataImportPreview(f.context,{...f.input,rows:f.input.rows.map(row=>({...row,code:row.code+'2',phone:''}))});
    f.store.dataImportBatches.get(expired.id).expiresAt=0;
    await rejectCode(f.store.commitDataImport(f.context,expired.id,expired.hash),'IMPORT_EXPIRED');
  }finally{await f.close();}
});
test('item units belong to the target company and duplicate phones are blockers',async()=>{
  const f=await fixture();try{
    const input={...f.input,entity:'items',rows:normalizeImportRows('items',[{sku:'X',name:'مادة',unitCode:'PC'}],{sku:'sku',name:'name',unitCode:'unitCode'})};
    f.store.units.set('foreign',{id:'foreign',companyId:'other',code:'PC'});
    assert.equal((await f.store.createDataImportPreview(f.context,input)).canCommit,false);
    await f.store.createUnit(f.context.company.id,{code:'PC',name:'قطعة'},f.context.user.id);
    const p=await f.store.createDataImportPreview(f.context,input);assert.equal(p.canCommit,true);await f.store.commitDataImport(f.context,p.id,p.hash);assert.equal(f.store.items.size,1);
    const duplicate=await f.store.createDataImportPreview(f.context,{...f.input,rows:f.input.rows.map(row=>({...row,phone:'123'}))});assert.ok(duplicate.issues.some(x=>x.code==='DUPLICATE_PHONE'));
  }finally{await f.close();}
});
test('supplier balances post to payable with the right sign and protect financial history',async()=>{
  const f=await fixture();try{
    const p=await f.store.createDataImportPreview(f.context,{...f.input,entity:'suppliers'});
    const result=await f.store.commitDataImport(f.context,p.id,p.hash);
    const positive=f.store.journalEntries.get(result.journalIds[0]),negative=f.store.journalEntries.get(result.journalIds[1]);
    assert.equal(positive.lines.find(line=>line.accountCode==='2100-AP').credit,'10.125000');
    assert.equal(negative.lines.find(line=>line.accountCode==='2100-AP').debit,'2.000000');
    await rejectCode(f.store.deleteSupplier(f.context.company.id,result.ids[0],f.context.user.id),'SUPPLIER_HAS_DOCUMENTS');
    assert.equal(f.store.debtMovements.size,0);
  }finally{await f.close();}
});
test('configured database sources cannot cross tenant boundaries or accept SQL identifiers',async()=>{
  const before=process.env.DATA_IMPORT_SOURCES_JSON;
  const config={format:'postgres',targetCompanyId:'company',targetBranchId:'branch',table:'customers',columns:['code','name'],companyColumn:'company_id',companyValue:'C',branchColumn:'branch_id',branchValue:'B',connection:{host:'127.0.0.1',database:'isolated',user:'reader'}};
  try{
    process.env.DATA_IMPORT_SOURCES_JSON=JSON.stringify({source:config});
    await rejectCode(readImportSource({format:'postgres',name:'source'},{companyId:'other',branchId:'branch'}),'SOURCE_NOT_ALLOWED');
    await rejectCode(readImportSource({format:'postgres',name:'source'},{companyId:'company',branchId:'other'}),'SOURCE_NOT_ALLOWED');
    process.env.DATA_IMPORT_SOURCES_JSON=JSON.stringify({source:{...config,table:'customers; DELETE FROM users'}});
    await rejectCode(readImportSource({format:'postgres',name:'source'},{companyId:'company',branchId:'branch'}),'SOURCE_CONFIG_INVALID');
    process.env.DATA_IMPORT_SOURCES_JSON=JSON.stringify({source:{...config,branchValue:null}});
    await rejectCode(readImportSource({format:'postgres',name:'source'},{companyId:'company',branchId:'branch'}),'SOURCE_CONFIG_INVALID');
  }finally{if(before===undefined)delete process.env.DATA_IMPORT_SOURCES_JSON;else process.env.DATA_IMPORT_SOURCES_JSON=before;}
});
test('HTTP endpoints require authentication and use the session company',async()=>{
  const f=await fixture();let server;try{
    const role={id:randomUUID(),companyId:f.context.company.id,permissions};f.store.roles.set(role.id,role);f.store.users.get(f.context.user.id).roleIds=[role.id];
    await f.store.createSession({tokenHash:hashToken('test-token'),userId:f.context.user.id,expiresAt:new Date(Date.now()+60000).toISOString()});
    server=createApp({store:f.store}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${server.address().port}/api/v1/data-import/preview`;
    const body={...f.input,rows:undefined,mapping,source:{format:'csv',content:encode('code,name,phone,openingBalance,currency\nA,First,123,10.125,USD\nB,Second,456,-2,USD')}};
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-token'},body:JSON.stringify(body)});assert.equal(response.status,201,JSON.stringify(await response.json()));
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.close();}
});
