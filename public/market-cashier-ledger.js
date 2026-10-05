(function(){
'use strict';
const context=JSON.parse(localStorage.getItem('almahasib_company_context')||'{}');
const scope=String(context.id||context.code||'unscoped').replace(/[^A-Za-z0-9_-]/g,'_');
const prefix='tenant:'+scope+':';
const key=name=>prefix+'market_'+name+'_v1';
const read=name=>{try{return JSON.parse(localStorage.getItem(key(name))||'[]')}catch{return[]}};
const write=(name,rows)=>localStorage.setItem(key(name),JSON.stringify(rows));
function decimal(value){const t=String(value??'0');if(!/^\d+(\.\d{1,6})?$/.test(t))throw new Error('مبلغ غير صالح');const [a,b='']=t.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'))}
function amount(n){return String(n/1000000n)+'.'+String(n%1000000n).padStart(6,'0')}
function upsert(name,row){const a=read(name),i=a.findIndex(x=>x.id===row.id);if(i<0)a.push(row);else a[i]={...a[i],...row};write(name,a)}
function invoiceFromSale(row){return {number:row.invoice,lines:row.lines||[],gross:row.gross,discount:row.discount,net:row.net,cash:row.cash??row.net,due:row.due||'0',received:row.received,change:row.change||'0',paymentType:row.paymentType||'cash',party:row.party||'',mode:'الماركتات',at:row.occurredAt,cashier:row.cashier,cashierCode:row.cashierCode,shiftId:row.shiftId,returned:false,cancelled:false}}
function apply(row){
 if(row.kind==='sale'){
  const a=read('invoices'),i=a.findIndex(x=>x.number===row.invoice);if(i<0)a.push(invoiceFromSale(row));else a[i]={...invoiceFromSale(row),...a[i]};write('invoices',a);
  if(row.heldId)apply({kind:'waiting_close',waitingId:row.heldId,occurredAt:row.occurredAt});
 }else if(row.kind==='waiting_update'||row.kind==='waiting_close'){
  const id=row.waitingId||row.draft?.id;if(!id)return;const versions=read('waiting_versions'),previous=versions.find(x=>x.id===id),at=row.occurredAt;
  if(previous&&previous.at>at)return;
  upsert('waiting_versions',{id,at,closed:row.kind==='waiting_close'});
  const held=read('held_sales').filter(x=>x.id!==id);if(row.kind==='waiting_update'&&row.draft)held.push(row.draft);write('held_sales',held);
 }else if(row.kind==='cash_in'||row.kind==='collection')upsert('cash_movements',row);
 else if(row.kind==='cancel'){
  const a=read('invoices'),x=a.find(x=>x.number===row.invoice);if(x){x.cancelled=true;x.cancelledAt=row.occurredAt;write('invoices',a)}
 }else if(row.kind==='return')upsert('returns',{...row,at:row.at||row.occurredAt});
}
let flushPromise=null;
async function flush(){if(flushPromise)return flushPromise;flushPromise=(async()=>{
 const runtime=window.AlMahasibMarketOffline;if(!runtime)throw new Error('انتظر تهيئة التخزين المحلي');
 for(const event of read('cashier_journal').filter(x=>!x.queued)){await runtime.queueTransaction(event.kind,event);const all=read('cashier_journal'),x=all.find(x=>x.id===event.id);if(x)x.queued=true;write('cashier_journal',all)}
})().finally(()=>{flushPromise=null});return flushPromise}
function record(kind,payload){const event={...payload,id:payload.id||crypto.randomUUID(),kind,occurredAt:payload.occurredAt||new Date().toISOString()};const all=read('cashier_journal');if(!all.some(x=>x.id===event.id)){all.push(event);write('cashier_journal',all);apply(event)}void flush().catch(()=>{});return event}
let pullPromise=null;
async function pull(){if(!navigator.onLine)return false;if(pullPromise)return pullPromise;pullPromise=(async()=>{
 let cursor=Number(localStorage.getItem(key('cashier_cursor'))||0);
 while(true){const r=await fetch('/api/v1/market/cashier-events?cursor='+cursor,{credentials:'same-origin',cache:'no-store'});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error?.message||'تعذرت مزامنة حسابات الانتظار');for(const row of b.events||[])apply(row);cursor=b.nextCursor;localStorage.setItem(key('cashier_cursor'),String(cursor));if(!b.hasMore)break}
 window.dispatchEvent(new Event('almahasib:cashier-records'));return true;
})().finally(()=>{pullPromise=null});return pullPromise}
function remaining(invoice){if(invoice.cancelled)return 0n;const paid=read('cash_movements').filter(x=>x.kind==='collection'&&x.state!=='rejected'&&x.invoice===invoice.number).reduce((n,x)=>n+decimal(x.amount),0n);const returns=read('returns').filter(x=>x.invoice===invoice.number).reduce((n,x)=>n+decimal(String(x.amount||0)),0n);const n=decimal(invoice.net||0)-decimal(invoice.cash??invoice.net??0)-paid-returns;return n>0n?n:0n}
function receivables(){return read('invoices').filter(x=>x.paymentType==='credit'||x.paymentType==='representative').map(x=>({...x,balance:amount(remaining(x))})).filter(x=>decimal(x.balance)>0n)}
function cashForShift(id){return read('cash_movements').filter(x=>x.shiftId===id&&x.state!=='rejected').reduce((r,x)=>{if(x.kind==='cash_in')r.cashIn+=Number(x.amount);if(x.kind==='collection')r.collections+=Number(x.amount);return r},{cashIn:0,collections:0})}
let busy=false;
async function collect(invoice,paid,shift){if(busy)return;busy=true;try{const x=read('invoices').find(x=>x.number===invoice);if(!x)throw new Error('الفاتورة غير موجودة');const n=decimal(paid),due=remaining(x);if(n<=0n||n>due)throw new Error('المبلغ يجب أن يكون أكبر من صفر ولا يتجاوز المتبقي');if(!shift||shift.status!=='open')throw new Error('افتح شفتًا لاستلام المبلغ');const event=record('collection',{invoice,party:x.party,paymentType:x.paymentType,amount:amount(n),shiftId:shift.id,cashier:shift.cashier,cashierCode:shift.cashierCode||'main'});await flush();window.dispatchEvent(new Event('almahasib:cashier-records'));return event}finally{busy=false}}
async function sync(){if(!navigator.onLine)throw new Error('لا يوجد اتصال؛ البيانات محفوظة محليًا');await flush();const runtime=window.AlMahasibMarketOffline;await runtime.syncTransactions();await runtime.syncTransactions();const cloud=await runtime.syncCloud();await pull();const status=await runtime.status();if(!cloud||status.pending||status.transactions||status.conflicts||status.rejected)throw new Error('لم تكتمل المزامنة؛ عمليات منتظرة: '+(status.pending+status.transactions)+'، تعارضات: '+status.conflicts+'، عمليات مرفوضة: '+status.rejected);return status}
async function backup(){await flush();const local={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith(prefix+'market_')){const raw=localStorage.getItem(k);if(k.includes(':market_work_')){const work=JSON.parse(raw);work.scannerToken=null;local[k]=JSON.stringify(work)}else local[k]=raw}}const indexed=await window.AlMahasibMarketOffline.exportData();return {format:'almahasib-cashier-backup',version:1,companyScope:scope,companyName:context.name,createdAt:new Date().toISOString(),local,indexed}}
async function restoreBackup(data){if(data?.format!=='almahasib-cashier-backup'||data.version!==1||data.companyScope!==scope)throw new Error('النسخة لا تخص هذه الشركة أو غير صالحة');for(const [k,v] of Object.entries(data.local||{})){if(!k.startsWith(prefix+'market_')||typeof v!=='string')throw new Error('بيانات النسخة غير صالحة')}
 if(!data.indexed||data.indexed.scope!==scope||['snapshots','outbox','transactions'].some(n=>!Array.isArray(data.indexed[n])))throw new Error('بيانات التخزين الاحتياطي غير صالحة');await window.AlMahasibMarketOffline.importData(data.indexed);
 for(const [k,v] of Object.entries(data.local||{})){
  if(k===key('cashier_cursor'))continue;
  if(localStorage.getItem(k)===null){localStorage.setItem(k,v);continue}
  let a,b;try{a=JSON.parse(localStorage.getItem(k));b=JSON.parse(v)}catch{continue}
  if(Array.isArray(a)&&Array.isArray(b)){for(const row of b){const id=row.id||row.number;if(!a.some(x=>(x.id||x.number)===id))a.push(row)}localStorage.setItem(k,JSON.stringify(a))}
 }
 localStorage.removeItem(key('cashier_cursor'));window.dispatchEvent(new Event('almahasib:cashier-records'));
}
window.MarketCashierLedger={read,record,flush,pull,remaining,receivables,cashForShift,collect,sync,backup,restoreBackup,decimal,amount};
window.addEventListener('almahasib:market-transaction-rejected',event=>{const row=event.detail;upsert('cash_movements',row);window.dispatchEvent(new Event('almahasib:cashier-records'));const el=document.getElementById('cashierActionStatus');if(el)el.textContent='رفض الخادم عملية قبض؛ راجع الرصيد ثم أعد تسجيل المبلغ الصحيح'});
window.addEventListener('online',()=>{void sync().catch(()=>{})});
document.addEventListener('DOMContentLoaded',()=>{for(const draft of read('held_sales')){if(!read('waiting_versions').some(x=>x.id===draft.id))record('waiting_update',{waitingId:draft.id,draft,occurredAt:draft.updatedAt||draft.at||new Date().toISOString()})}void flush().then(()=>navigator.onLine?pull():false).catch(()=>{})});
})();
