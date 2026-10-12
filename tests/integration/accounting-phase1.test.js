import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';

test('accounting API authenticates, persists drafts, approves, reports and closes through local SQLite runtime',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'phase1-api-'));let runtime,cookie='';
 try{
  runtime=await startEnterpriseLocal({dataDirectory:directory,port:33228});
  const request=async(path,body,method='POST')=>{const r=await fetch(runtime.url+path,{headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{method,body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
  assert.equal((await request('/api/v1/accounting/openings')).status,401);
  const credentials={legalName:'شركة فحص معزولة',ownerName:'المدير',username:'phase1_owner',password:'Strong-Phase1-123'};
  assert.equal((await request('/api/local/setup',credentials)).status,201);
  assert.equal((await request('/api/v1/auth/login',{companyCode:'local',username:credentials.username,password:credentials.password})).status,200);
  const input={period:'2026',currency:'IQD',lines:[{accountCode:'1000-CASH',debit:'100',source:'الجرد'},{accountCode:'3000-EQUITY',credit:'100',source:'تأسيس'}]};
  const draft=await request('/api/v1/accounting/openings',input);assert.equal(draft.status,201,JSON.stringify(draft.data));
  assert.equal((await request('/api/v1/accounting/openings/'+draft.data.opening.id+'/approve',{})).status,200);
  const report=await request('/api/v1/accounting/reports?from=2026-01-01&to=2026-12-31');assert.equal(report.status,200,JSON.stringify(report.data));assert.equal(report.data.statements[0].balanceSheet.assets,'100.000000');
  const ledger=await request('/api/v1/accounting/reports?accountCode=1000-CASH&from=2026-02-01');assert.equal(ledger.data.ledger.openingBalances[0].balance,'100.000000');
  const invalid=await request('/api/v1/accounting/reports?from=2026-02-30');assert.equal(invalid.status,400);
  const close=await request('/api/v1/accounting/periods/close',{startDate:'2026-01-01',endDate:'2026-01-31',generateClosing:true,reason:'تمت المراجعة'});assert.equal(close.status,201,JSON.stringify(close.data));
  assert.equal((await request('/api/v1/accounting/openings',{...input,description:'محاولة متأخرة'})).status,409);
  assert.equal((await request('/api/v1/treasury/closures')).status,200);
 }finally{if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
