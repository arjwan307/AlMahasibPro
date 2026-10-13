import {randomUUID} from 'node:crypto';
import {AppError,asyncRoute} from '../../lib/http.js';
import {decimal as parseDecimal,decimalString,multiply,divide,normalizeDecimalInput} from '../../lib/decimal.js';
import {warehouseScopeAllows,documentScopeAllows} from '../../lib/warehouse-scope.js';
import {salesRep,salesScoped} from '../../sales-workspace.js';
import {normalizeAssistantText} from './read-only.js';

const decimal=(value,options)=>{try{return parseDecimal(value,options);}catch{throw new AppError(409,'INVALID_ACCOUNTING_VALUE','يوجد مبلغ أو كمية غير صالح؛ لا يمكن إكمال المهمة');}};
const requirePermissions=(auth,permissions)=>{if(!['assistant.use',...permissions].every(p=>auth.permissions?.includes(p)))throw new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية لتنفيذ هذه المهمة');};
const normalize=value=>normalizeAssistantText(value).toLocaleLowerCase('ar');
const exact=(rows,reference,fields)=>{if(typeof reference!=='string'||!reference.trim())throw new AppError(400,'REFERENCE_REQUIRED','حدد الاسم أو الكود المطلوب');const found=rows.filter(row=>fields.some(field=>normalize(row[field])===normalize(reference)));if(found.length!==1)throw new AppError(409,found.length?'AMBIGUOUS_REFERENCE':'REFERENCE_NOT_FOUND',found.length?'الاسم غير فريد؛ استخدم الكود المحدد':'لم أجد السجل المحدد؛ استخدم الاسم أو الكود كما يظهر في النظام');return found[0];};
const quoted=(text,label)=>text.match(new RegExp('(?:'+label+')\\s*["«]([^"»]+)["»]'))?.[1];
const report=(title,columns,rows)=>({title,columns,rows});

export async function prepareSalesDraft(store,auth,message,validateDocument){
 requirePermissions(auth,['sales.create','catalog.read','customers.read','inventory.read']);
 if(typeof message!=='string'||!message.trim()||message.length>4000)throw new AppError(400,'INVALID_REQUEST','اكتب طلب الفاتورة');
 const text=normalizeAssistantText(message).replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x0660));
 const customerRef=quoted(text,'للزبون|للعميل|الزبون|العميل|لزبون|لعميل'),warehouseRef=quoted(text,'المخزن');
 if(!customerRef)throw new AppError(400,'CUSTOMER_REQUIRED','حدد الزبون بين علامتي اقتباس، مثال: أعد فاتورة للزبون "C1" الصنف "A1" الكمية 2');
 const data=await store.listMasterData(auth.company.id),profile=store.salesSettings.get('user:'+auth.user.id)||{},channel=salesScoped(store,auth)?profile.channel||'retail':/جملة/.test(text)?'wholesale':'retail';
 if(salesScoped(store,auth)&&/جملة/.test(text)&&channel!=='wholesale')throw new AppError(403,'SALES_CHANNEL_DENIED','نوع المبيعات لا يطابق صلاحية حسابك');
 if(/نقد|مختلط|واصل|دفع/.test(text))throw new AppError(400,'PAYMENT_REVIEW_REQUIRED','إعداد الفاتورة هنا يكون آجلاً؛ اضبط التحصيل داخل شاشة المبيعات قبل إرسال الفاتورة');
 const customers=data.customers.filter(c=>!salesScoped(store,auth)||(store.salesSettings.get('customer:'+c.id)?.channel||'retail')===channel);
 const customer=exact(customers,customerRef,['id','code','name']);
 const warehouses=data.warehouses.filter(w=>warehouseScopeAllows(auth,w)&&!store.salesSettings.get('warehouse:'+w.id)?.damaged);
 const warehouse=warehouseRef?exact(warehouses,warehouseRef,['id','code','name']):warehouses.length===1?warehouses[0]:null;
 if(!warehouse)throw new AppError(409,'WAREHOUSE_REQUIRED','حدد المخزن بين علامتي اقتباس؛ لا أختار مخزناً بالنيابة عنك');
 const matches=[...text.matchAll(/(?:الصنف|المادة)\s*["«]([^"»]+)["»]\s*(?:الكمية|كمية|عدد)\s*([0-9]+(?:[.,][0-9]+)?)/g)];
 const itemMentions=[...text.matchAll(/(?:الصنف|المادة)\s*["«]/g)].length;
 if(!matches.length||matches.length!==itemMentions)throw new AppError(400,'ITEM_QUANTITY_REQUIRED','كل صنف يحتاج اسماً أو كوداً وكمية، مثال: الصنف "A1" الكمية 2؛ الصنف "B1" الكمية 3');
 const lines=[],seen=new Set(),rows=[];let gross=0n;
 for(const match of matches){
  const item=exact(data.items.filter(i=>i.active!==false),match[1],['id','sku','name']);
  if(seen.has(item.id))throw new AppError(400,'DUPLICATE_ITEM','كرر الصنف مرة واحدة واجمع كميته');seen.add(item.id);
  const quantity=decimal(normalizeDecimalInput(match[2]),{positive:true}),relation=item.units?.find(u=>u.unitId===item.baseUnitId);
  if(!relation)throw new AppError(409,'UNIT_REQUIRED','الوحدة الأساسية للصنف غير معرفة');
  const prices=data.prices.filter(p=>p.active!==false&&p.itemId===item.id&&p.unitId===item.baseUnitId&&p.currency===auth.company.currency),price=prices.filter(p=>p.priceType==='sale_'+channel).at(-1)||prices.filter(p=>p.priceType==='sale').at(-1);
  if(!price||decimal(price.amount,{positive:true})<=0n)throw new AppError(409,'PRICE_REQUIRED','لا يوجد سعر بيع صالح للصنف '+item.name);
  const required=multiply(quantity,decimal(relation.conversionFactor,{positive:true})),stock=data.stock.find(s=>s.warehouseId===warehouse.id&&s.itemId===item.id),cfg=store.salesSettings.get('item:'+item.id)||{};
  const temporary=(store.salesSettings.get('reservations:'+auth.company.id)?.rows||[]).filter(r=>r.status==='active'&&Date.parse(r.expiresAt)>Date.now()).flatMap(r=>r.lines).filter(l=>l.itemId===item.id&&l.warehouseId===warehouse.id).reduce((n,l)=>n+decimal(l.baseQuantity),0n);
  const available=decimal(stock?.quantity||'0')-decimal(cfg.reserved?.[warehouse.id]||'0')-temporary;
  if(required>available)throw new AppError(409,'INSUFFICIENT_STOCK','الرصيد المتاح لا يكفي للصنف '+item.name);
  const amount=multiply(quantity,decimal(price.amount));gross+=amount;
  lines.push({itemId:item.id,unitId:item.baseUnitId,warehouseId:warehouse.id,quantity:decimalString(quantity),unitPrice:decimalString(decimal(price.amount))});
  rows.push([item.sku,item.name,warehouse.name,decimalString(quantity),price.amount,decimalString(amount)]);
 }
 const discountMatch=text.match(/خصم\s*([0-9]+(?:[.,][0-9]+)?)\s*[%٪]/),discountPercent=discountMatch?decimal(normalizeDecimalInput(discountMatch[1]),{nonNegative:true}):0n;
 if(/خصم/.test(text)&&!discountMatch)throw new AppError(400,'INVALID_DISCOUNT','حدد الخصم كنسبة مثل خصم 12٪');
 if(discountPercent>decimal('100'))throw new AppError(400,'INVALID_DISCOUNT','الخصم لا يتجاوز 100٪');
 const discount=multiply(gross,divide(discountPercent,decimal('100'))),net=gross-discount;
 const document=validateDocument({documentType:'sale',documentNumber:'AI-'+randomUUID(),warehouseId:warehouse.id,branchId:warehouse.branchId||null,partyId:customer.id,currency:auth.company.currency,discountAmount:decimalString(discount),delivery:{mode:'immediate'},lines,payments:[]});
 return {localOnly:true,requestId:randomUUID(),document,representative:salesRep(auth),customerName:customer.name,discountPercent:decimalString(discountPercent),total:decimalString(net),paymentMode:'credit',report:report('فاتورة معدة للمراجعة — لم تُحفظ',['الكود','الصنف','المخزن','الكمية','سعر النظام','إجمالي البند'],rows),notice:'الفاتورة آجلة دون تسجيل تحصيل. راجع الزبون والكمية والخصم والدفع قبل إرسالها أو اعتمادها. الأسعار والأرصدة من النظام؛ لم يُرحّل أي قيد أو مخزون.'};
}

function findDocument(store,auth,reference){const docs=[...store.commerceDocuments.values()].filter(d=>d.companyId===auth.company.id&&documentScopeAllows(store,auth,d));return exact(docs,reference,['id','documentNumber']);}
function visibleJournal(store,auth,journal){if(journal.companyId!==auth.company.id)return false;const doc=journal.documentId?store.commerceDocuments.get(journal.documentId):null;if(doc)return doc.companyId===auth.company.id&&documentScopeAllows(store,auth,doc);const warehouses=(auth.scopes||[]).filter(s=>s.type==='warehouse'),branches=(auth.scopes||[]).filter(s=>s.type==='branch');return !warehouses.length&&(!branches.length||branches.some(s=>s.id===journal.branchId));}

export async function inspectJournal(store,auth,reference){
 requirePermissions(auth,['accounting.read']);
 const journal=exact([...store.journalEntries.values()].filter(j=>visibleJournal(store,auth,j)),reference,['id','entryNumber']);
 const accounts=new Set((await store.listChartAccounts(auth.company.id)).map(a=>a.code)),rows=[];let debit=0n,credit=0n;
 for(const [index,line] of (journal.lines||[]).entries()){
  const code=line.accountCode||line.account,issues=[];let d=0n,c=0n;
  try{d=decimal(line.debit||'0',{nonNegative:true});c=decimal(line.credit||'0',{nonNegative:true});debit+=d;credit+=c;if((d>0n)===(c>0n))issues.push('الطرف يجب أن يكون مديناً أو دائناً فقط');}catch{issues.push('مبلغ غير صالح');}
  if(!accounts.has(code))issues.push('الحساب غير موجود في دليل الشركة');rows.push([index+1,code,line.debit||'0',line.credit||'0',issues.join('؛ ')||'سليم ضمن فحوص المبلغ والحساب']);
 }
 const difference=debit-credit,findings=rows.filter(r=>r[4]!=='سليم ضمن فحوص المبلغ والحساب').length+(difference!==0n||debit===0n?1:0);
 return {localOnly:true,journalId:journal.id,findings,debit:decimalString(debit),credit:decimalString(credit),difference:decimalString(difference),report:report('مراجعة القيد '+journal.entryNumber,['الطرف','الحساب','مدين','دائن','نتيجة الفحص'],rows),notice:'فحص حتمي للمبالغ والتوازن والحسابات؛ لا يثبت صحة المبرر التجاري ولا يعدل القيد.'};
}

export function reconcileInvoice(store,auth,reference){
 requirePermissions(auth,['sales.read','accounting.read','inventory.read']);
 const doc=findDocument(store,auth,reference);if(doc.documentType!=='sale')throw new AppError(400,'SALE_REQUIRED','اختر فاتورة مبيعات');
 const linked=[...store.journalEntries.values()].filter(j=>j.companyId===auth.company.id&&j.documentId===doc.id),journal=linked.length===1?linked[0]:null,rows=[];
 const check=(label,expected,actual,evidence)=>rows.push([label,decimalString(expected),actual==null?'غير متاح':decimalString(actual),actual==null?'غير محسوب':decimalString(actual-expected),actual==null?'دليل مفقود':expected===actual?'متطابق':'فرق',evidence||'—']);
 const sum=(entries,field)=>entries.reduce((n,l)=>n+decimal(l[field]||'0',{nonNegative:true}),0n);
 const net=decimal(doc.subtotal),paid=decimal(doc.paidAmount),due=decimal(doc.dueAmount),cost=(doc.lines||[]).reduce((n,l)=>n+multiply(decimal(l.baseQuantity,{positive:true}),decimal(l.unitCost,{nonNegative:true})),0n);
 check('الإجمالي ناقص الخصم',net,decimal(doc.grossAmount)-decimal(doc.discountAmount||'0'),doc.id);
 check('المدفوع + الآجل',net,paid+due,doc.id);
 check('تحصيلات الفاتورة عند الإنشاء',paid,sum(doc.payments||[],'amount'),doc.id);
 if(!journal||journal.companyId!==auth.company.id||journal.documentId!==doc.id)check('القيد المرتبط',net,null,doc.journalEntryId);
 else{
  rows.push(['عملة القيد',doc.currency,journal.currency,'—',doc.currency===journal.currency?'متطابق':'فرق',journal.id]);
  const lines=journal.lines||[],account=(code,side)=>sum(lines.filter(l=>(l.accountCode||l.account)===code),side);
  check('توازن القيد',sum(lines,'debit'),sum(lines,'credit'),journal.id);
  check('النقد أو عهدة المندوب عند الإنشاء',paid,sum(lines.filter(l=>['1000-CASH','1000-CASH-USD','1150-REP-CASH-CUSTODY'].includes(l.accountCode||l.account)),'debit'),journal.id);
  check('إيراد المبيعات',net,account('4100-SALES','credit'),journal.id);
  check('الذمة المدينة عند الإنشاء',due,account('1100-AR','debit'),journal.id);
  check('تكلفة المخزون الخارجة',cost,account('1200-INVENTORY','credit'),journal.id);
  check('تكلفة البضاعة المباعة',cost,account('5100-COGS','debit'),journal.id);
 }
 let collected=0n;
 for(const payment of store.financialRecords.values())if(payment.companyId===auth.company.id&&payment.documentId===doc.id&&['enterprise_settlement','enterprise_credit_application'].includes(payment.kind)){
  collected+=decimal(payment.amount);const entry=store.journalEntries.get(payment.journalEntryId),amount=decimal(payment.totalDocumentAmount||payment.amount);
  const valid=entry&&entry.companyId===auth.company.id&&entry.currency===payment.currency&&entry.status==='posted';
  check('مدين سند '+(payment.receiptNumber||payment.id),amount,valid?sum(entry.lines||[],'debit'):null,payment.journalEntryId);
  check('دائن سند '+(payment.receiptNumber||payment.id),amount,valid?sum(entry.lines||[],'credit'):null,payment.journalEntryId);
 }
 const returned=[...store.commerceDocuments.values()].filter(d=>d.companyId===auth.company.id&&d.documentType==='sale_return'&&d.originalDocumentId===doc.id&&documentScopeAllows(store,auth,d)).reduce((n,d)=>n+decimal(d.dueAmount),0n);
 return {localOnly:true,documentId:doc.id,findings:rows.filter(r=>r[4]!=='متطابق').length,outstanding:decimalString(due-collected-returned),report:report('مطابقة الفاتورة '+doc.documentNumber,['الفحص','المتوقع','المسجل','الفرق','النتيجة','مرجع الدليل'],rows),notice:'أثر المخزون هنا هو تكلفة البضاعة في القيد المرتبط. الرصيد الحالي تراكمي ولا يثبت وحده الكمية التاريخية؛ لا أعتبر المطابقة إثباتاً لجرد فعلي. لم أغيّر أي سجل.'};
}

export function installWorkbenchRoutes(app,{store,authenticate,validateDocument}){
 app.post('/api/v1/assistant/workbench/prepare',authenticate,asyncRoute(async(req,res)=>res.json(await prepareSalesDraft(store,req.auth,req.body.message,validateDocument))));
 app.post('/api/v1/assistant/workbench/journal',authenticate,asyncRoute(async(req,res)=>res.json(await inspectJournal(store,req.auth,String(req.body.reference||'')))));
 app.post('/api/v1/assistant/workbench/reconcile',authenticate,asyncRoute(async(req,res)=>res.json(reconcileInvoice(store,req.auth,String(req.body.reference||'')))));
}
