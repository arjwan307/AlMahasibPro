import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SQLiteStore} from '../apps/api/src/store/sqlite-store.js';

const company={id:'company-one',name:'الشركة',currency:'IQD',timezone:'Asia/Baghdad',branches:[{id:'branch-a',name:'أ'},{id:'branch-b',name:'ب'}]};
const context={company,user:{id:'owner'},permissions:['company.manage','accounting.post','accounting.read'],scopes:[]};
const opening=(credit='100')=>({period:'2026',currency:'IQD',lines:[{accountCode:'1000-CASH',debit:'100',source:'كشف الصندوق'},{accountCode:'3000-EQUITY',credit,source:'عقد التأسيس'}]});
const manual=(lines,date='2026-02-01T12:00:00Z')=>({operationId:randomUUID(),entryNumber:randomUUID(),occurredAt:date,lines});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'accounting-phase1-'));let store=new SQLiteStore(join(dir,'erp.sqlite'));store.companies.set(company.id,company);t.after(async()=>{await store.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},async restart(){await store.close();store=new SQLiteStore(join(dir,'erp.sqlite'));return store;}};}

test('opening draft persists, rejects imbalance and unauthorized approval, posts once and survives restart',async t=>{
 const fixture=setup(t),s=fixture.store;
 const draft=await s.saveOpeningJournal(context,opening('90'));
 assert.equal(s.journalEntries.size,0);
 await assert.rejects(s.approveOpeningJournal(context,draft.id),{code:'UNBALANCED_JOURNAL'});
 assert.equal(s.journalEntries.size,0);
 await assert.rejects(s.approveOpeningJournal({...context,permissions:['accounting.post']},draft.id),{code:'PERMISSION_DENIED'});
 await s.saveOpeningJournal(context,opening(),draft.id);
 const posted=await s.approveOpeningJournal(context,draft.id);assert.equal(posted.status,'posted');
 await s.approveOpeningJournal(context,draft.id);assert.equal(s.journalEntries.size,1);
 await assert.rejects(s.saveOpeningJournal(context,opening(),draft.id),{code:'OPENING_LOCKED'});
 const duplicate=await s.saveOpeningJournal(context,opening());await assert.rejects(s.approveOpeningJournal(context,duplicate.id),{code:'OPENING_PERIOD_EXISTS'});
 const restored=await fixture.restart();assert.equal((await restored.listOpeningJournals(context)).find(x=>x.id===posted.id).status,'posted');
 assert.equal((await restored.accountingReport(context)).statements[0].balanceSheet.assets,'100.000000');
});

test('opening is isolated by tenant and branch, currency totals are kept separate, source evidence is required',async t=>{
 const s=setup(t).store;
 const draft=await s.saveOpeningJournal(context,{...opening(),branchId:'branch-a'});
 await assert.rejects(s.approveOpeningJournal({...context,company:{...company,id:'other'}},draft.id),{code:'OPENING_NOT_FOUND'});
 await assert.rejects(s.approveOpeningJournal({...context,scopes:[{type:'branch',id:'branch-b'}]},draft.id),{code:'BRANCH_SCOPE_DENIED'});
 assert.equal((await s.listOpeningJournals({...context,scopes:[{type:'branch',id:'branch-b'}]})).length,0);
 await s.approveOpeningJournal(context,draft.id);
 const usd=await s.saveOpeningJournal(context,{...opening(),currency:'USD',branchId:'branch-a'});await s.approveOpeningJournal(context,usd.id);
 const r=await s.accountingReport(context,{branchId:'branch-a'});assert.equal(r.statements.length,2);assert.ok(r.statements.every(x=>x.balanceSheet.assets==='100.000000'));
 const noSource=opening();noSource.lines[0].source='';const missing=await s.saveOpeningJournal(context,{...noSource,branchId:'branch-b'});await assert.rejects(s.approveOpeningJournal(context,missing.id),{code:'OPENING_SOURCE_REQUIRED'});
});

test('ledger, period profit, cumulative balance sheet and cash flow reconcile; closing journal clears income accounts and locks posting',async t=>{
 const s=setup(t).store,draft=await s.saveOpeningJournal(context,opening());await s.approveOpeningJournal(context,draft.id);
 const sale=await s.postManualJournal(context,manual([{accountCode:'1000-CASH',debit:'80'},{accountCode:'4100-SALES',credit:'80'}]));
 await s.classifyCashFlow(context,sale.id,'operating','تحصيل مبيعات');
 const expense=await s.postManualJournal(context,manual([{accountCode:'6100-PAYROLL-EXPENSE',debit:'30'},{accountCode:'1000-CASH',credit:'30'}]));
 await s.classifyCashFlow(context,expense.id,'operating','رواتب');
 const report=await s.accountingReport(context,{from:'2026-02-01',to:'2026-02-28'});
 assert.equal(report.statements[0].profitAndLoss.netProfit,'50.000000');assert.equal(report.statements[0].balanceSheet.assets,'150.000000');assert.equal(report.cashFlow[0].opening,'100.000000');assert.equal(report.cashFlow[0].operating,'50.000000');assert.equal(report.cashFlow[0].difference,'0.000000');assert.equal(report.cashFlow[0].complete,true);
 const ledger=(await s.accountingReport(context,{accountCode:'1000-CASH',from:'2026-02-01',to:'2026-02-28'})).ledger;assert.equal(ledger.openingBalances[0].balance,'100.000000');assert.equal(ledger.entries.at(-1).balance,'150.000000');
 const period=await s.closeFinancialPeriod(context,{startDate:'2026-01-01',endDate:'2026-02-28',reason:'إقفال معتمد',generateClosing:true});assert.equal(period.closingJournalIds.length,1);
 const rows=await s.trialBalance(company.id);assert.equal(rows.find(x=>x.accountCode==='4100-SALES').balance,'0.000000');assert.equal(rows.find(x=>x.accountCode==='3100-RETAINED-EARNINGS').balance,'-50.000000');
 const closed=await s.accountingReport(context,{from:'2026-02-01',to:'2026-02-28'});assert.equal(closed.statements[0].profitAndLoss.netProfit,'50.000000');assert.equal(closed.statements[0].balanceSheet.difference,'0.000000');
 await assert.rejects(s.postManualJournal(context,manual([{accountCode:'1000-CASH',debit:'1'},{accountCode:'3000-EQUITY',credit:'1'}])),{code:'FINANCIAL_PERIOD_CLOSED'});
});

test('cash closing requires approved variance reason, archives voucher and blocks backdated posting; opening does not duplicate cash balances',async t=>{
 const s=setup(t).store;
 const box=await s.createCashbox(context,{code:'MAIN',name:'الرئيسي',currency:'IQD',branchId:'branch-a'});
 const draft=await s.saveOpeningJournal(context,{...opening(),branchId:'branch-a',lines:[{accountCode:box.accountCode,debit:'100',source:'عد نقدي'},{accountCode:'3000-EQUITY',credit:'100',source:'رأس المال'}]});await s.approveOpeningJournal(context,draft.id);
 const session=await s.openCashbox(context,box.id,{operationId:randomUUID(),sessionNumber:'S1',openingBalance:'100',openedAt:'2026-02-01T10:00:00Z'});assert.equal(s.journalEntries.size,1);
 const close={operationId:randomUUID(),countedBalance:'95',closedAt:'2026-02-01T15:00:00Z',requireReview:true};
 await assert.rejects(s.closeCashbox(context,box.id,session.id,close),{code:'VARIANCE_REASON_REQUIRED'});assert.equal(s.journalEntries.size,1);
 const result=await s.closeCashbox(context,box.id,session.id,{...close,reason:'عجز مثبت'});assert.equal(result.closingVoucher.variance,'-5.000000');assert.equal(result.closingVoucher.reviewedBy,'owner');
 const count=s.journalEntries.size;await s.closeCashbox(context,box.id,session.id,{...close,reason:'عجز مثبت'});assert.equal(s.journalEntries.size,count);
 await assert.rejects(s.postManualJournal(context,{...manual([{accountCode:box.accountCode,debit:'1'},{accountCode:'3000-EQUITY',credit:'1'}],'2026-02-01T12:00:00Z'),branchId:'branch-a'}),{code:'CASHBOX_SESSION_CLOSED'});
});

test('cashier submits count, stale count is rejected and reviewed voucher includes cashier identity',async t=>{
 const s=setup(t).store,box=await s.createCashbox(context,{code:'REQUEST',name:'الصندوق',currency:'IQD',branchId:'branch-a'});
 const session=await s.openCashbox(context,box.id,{operationId:randomUUID(),sessionNumber:'R1',openingBalance:'100',openedAt:'2026-02-01T10:00:00Z'});
 const cashier={...context,user:{id:'cashier'},permissions:['pos.shift.close']};
 await s.requestCashboxClose(cashier,box.id,session.id,{countedBalance:'100'});
 await s.postCashboxMovement(context,box.id,{operationId:randomUUID(),movementNumber:'R-1',direction:'in',amount:'5',counterAccountCode:'3000-EQUITY',occurredAt:'2026-02-01T12:00:00Z'});
 await assert.rejects(s.closeCashbox(context,box.id,session.id,{operationId:randomUUID(),countedBalance:'100',closedAt:'2026-02-01T15:00:00Z',requireReview:true}),{code:'CASH_COUNT_STALE'});
 await s.requestCashboxClose(cashier,box.id,session.id,{countedBalance:'105'});
 const closed=await s.closeCashbox(context,box.id,session.id,{operationId:randomUUID(),countedBalance:'105',closedAt:'2026-02-01T15:00:00Z',requireReview:true});assert.equal(closed.closingVoucher.countedBy,'cashier');assert.equal(closed.closingVoucher.receipts,'5.000000');
});
