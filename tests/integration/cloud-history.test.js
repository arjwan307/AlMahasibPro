import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serialize} from 'node:v8';
import {SQLiteStore} from '../../apps/api/src/store/sqlite-store.js';

test('cloud restore imports historical postings and closed periods without disabling new posting validation',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'almahasib-history-'));
 const source=new SQLiteStore(join(folder,'source.sqlite')),target=new SQLiteStore(join(folder,'target.sqlite'));t.after(async()=>{await source.close();await target.close();});
 const company=await source.registerCompany({code:'history',legalName:'History',currency:'IQD',timezone:'Asia/Baghdad',owner:{username:'owner',displayName:'Owner',passwordHash:'test'}});
 // A previous cloud release can contain journal rows without occurredAt.
 const journals=new Map([['legacy',{id:'legacy',companyId:company.id,createdAt:'2025-01-01T00:00:00Z',lines:[]}],['closed',{id:'closed',companyId:company.id,occurredAt:'2025-01-01T00:00:00Z',lines:[]}]]);
 const periods=new Map([['p',{id:'p',companyId:company.id,startDate:'2025-01-01',endDate:'2025-01-31',status:'closed'}]]);
 const write=source.sqlite.prepare('INSERT INTO domain_state(data,field) VALUES (?,?) ON CONFLICT(field) DO UPDATE SET data=excluded.data');write.run(serialize(journals),'journalEntries');write.run(serialize(periods),'financialPeriods');
 const bytes=await source.exportBackup();assert.equal(await target.importCloudSnapshot(bytes,company.id,{initial:true}),true);assert.equal(target.journalEntries.size,2);
 await assert.rejects(target.transaction(()=>target.journalEntries.set('bad',{id:'bad',companyId:company.id,lines:[]})),/تاريخ الترحيل غير صالح/);
 await assert.rejects(target.transaction(()=>target.journalEntries.set('new',{id:'new',companyId:company.id,occurredAt:'2025-01-05T00:00:00Z',lines:[]})),/الفترة المالية مقفلة/);
 assert.equal(target.journalEntries.size,2);
});

