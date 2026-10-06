import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseCloud} from '../../apps/api/src/cloud-server.js';
import {demoWholesaleCustomers} from '../../apps/api/src/demo-wholesale-customers.js';
test('150 wholesale demo customers have balanced small USD openings, channel isolation and idempotent persistent imports',async()=>{
 const catalog=demoWholesaleCustomers();assert.equal(catalog.customers.length,150);assert.equal(new Set(catalog.customers.map(x=>x.name)).size,150);assert.equal(catalog.customers.filter(x=>x.balance<0).length,3);assert(catalog.customers.every(x=>Math.abs(x.balance)<=300));
 const dir=await mkdtemp(join(tmpdir(),'demo-wholesale-'));let rt;let cookie='';const options={dataDirectory:dir,setupToken:'customers-test-key-123456789012345',origin:'https://example.test',port:0};
 try{
 rt=await startEnterpriseCloud(options);const req=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(rt.url+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 assert.equal((await req('/api/local/setup',{setupToken:options.setupToken,legalName:'زبائن تجريبيون',ownerName:'مدير',username:'admin',password:'Strong-Password-123'})).status,201);cookie=(await req('/api/v1/auth/login',{companyCode:'company',username:'admin',password:'Strong-Password-123'})).cookie;
 const marker=()=>writeFile(join(dir,'demo-wholesale-customers-request.json'),JSON.stringify({companyCode:'company',catalog:catalog.version}));
 await rt.close();await marker();rt=await startEnterpriseCloud(options);
 const result=JSON.parse(await readFile(join(dir,'demo-wholesale-customers-result.json'),'utf8'));assert.equal(result.customersCreated,150);assert.equal(result.cashCustomers,90);assert.equal(result.debitCustomers,57);assert.equal(result.creditCustomers,3);assert.equal(result.openingEntries,60);
 const data=(await req('/api/v1/sales/bootstrap')).data;assert.equal(data.customers.length,150);assert(data.customers.every(x=>x.channel==='wholesale'&&x.demo&&x.openingBalances[0].currency==='USD'));assert.equal(data.documents.length,0);
 const master=(await req('/api/v1/master-data')).data;assert.equal(master.customers.filter(x=>Number(x.openingBalances[0].amount)<0).length,3);
 const company=[...rt.store.companies.values()][0];
 const journals=[...rt.store.journalEntries.values()].filter(x=>x.companyId===company.id);assert.equal(journals.length,60);assert(journals.every(x=>x.currency==='USD'&&x.lines.reduce((s,l)=>s+Number(l.debit)-Number(l.credit),0)===0));assert.equal(rt.store.retailStore?.customers?.size||rt.retailStore.customers.size,0);
 const adminCookie=cookie;const user=(await req('/api/v1/users',{username:'retail',displayName:'مندوب مفرد',roleCode:'representative',password:'Strong-Password-123'})).data.user;
 assert.equal((await req('/api/v1/sales/settings/user/'+user.id,{channel:'retail',maxDiscountPercent:'0'},'PUT')).status,200);
 cookie=(await req('/api/v1/auth/login',{companyCode:'company',username:'retail',password:'Strong-Password-123'})).cookie;assert.equal((await req('/api/v1/sales/bootstrap')).data.customers.length,0);assert.equal((await req('/api/v1/master-data')).data.customers.length,0);
 cookie=adminCookie;assert.equal((await rt.store.listMasterData('unrelated-company')).customers.length,0);
 await rt.close();await marker();rt=await startEnterpriseCloud(options);const repeated=JSON.parse(await readFile(join(dir,'demo-wholesale-customers-result.json'),'utf8'));assert.equal(repeated.customersCreated,0);assert.equal(repeated.existingCustomers,150);assert.equal((await req('/api/v1/master-data')).data.customers.length,150);
 }finally{await rt?.close();await rm(dir,{recursive:true,force:true});}
});
