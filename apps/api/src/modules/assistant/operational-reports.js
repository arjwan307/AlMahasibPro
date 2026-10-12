import {decimal, decimalString} from '../../lib/decimal.js';

const TYPES = {sale:'بيع',sale_return:'مرتجع بيع',purchase:'شراء',purchase_return:'مرتجع شراء'};
const TOTAL_LIMIT = 2000;
const fail = (status, code, message) => ({status,code,message});
const table = (title,columns,rows) => ({title,columns,rows:rows.slice(0,TOTAL_LIMIT),totalRows:rows.length,truncated:rows.length>TOTAL_LIMIT});
const result = (answer,report) => ({answer,report,localOnly:true,readOnly:true,model:'محرك المحاسبة'});

export async function operationalReport(intent, store, auth, query, {period,canSeeWarehouse,salesScoped,channel}) {
  const has = permission => auth.permissions?.includes(permission);
  const companyId = auth.company.id;
  const inPeriod = date => {const time=Date.parse(date||'');return Number.isFinite(time)&&time>=period.start.getTime()&&time<=period.end.getTime();};
  const localRow = row => row.companyId===companyId;
  const source = name => typeof store[name]==='function';
  const visibleDoc = doc => (doc.companyId==null||localRow(doc))&&(doc.status==null||doc.status==='posted')&&canSeeWarehouse(doc.warehouseId)&&
    (!salesScoped||(doc.documentType.startsWith('sale')&&doc.customerId&&(store.salesSettings?.get('customer:'+doc.customerId)?.channel||'retail')===channel&&
      (!store.salesSettings?.get('user:'+auth.user?.id)?.salesManager||!doc.assignedSalesManagerId||doc.assignedSalesManagerId===auth.user?.id)));

  if (['sales-report','purchase-report'].includes(intent)) {
    const sale=intent==='sales-report',permission=sale?'sales.read':'purchasing.read';
    if(!has(permission)||!sale&&salesScoped)return fail(403,'PERMISSION_DENIED','لا تملك صلاحية قراءة هذه الفواتير');
    if(!source('listCommerceDocuments'))return fail(501,'ASSISTANT_DATA_SOURCE_UNAVAILABLE','مصدر الفواتير غير متاح');
    const docs=(await store.listCommerceDocuments(companyId)).filter(doc=>visibleDoc(doc)&&doc.documentType.startsWith(sale?'sale':'purchase')&&inPeriod(doc.occurredAt));
    const totals=new Map(),rows=[];
    for(const doc of docs){
      const returned=doc.documentType.endsWith('_return'),sign=returned?-1n:1n,currency=doc.currency||auth.company.currency;
      const subtotal=decimal(doc.subtotal||'0'),paid=decimal(doc.paidAmount||'0'),due=decimal(doc.dueAmount||'0');
      const total=totals.get(currency)||{count:0,returns:0,subtotal:0n,paid:0n,due:0n};
      total.count++;if(returned)total.returns++;total.subtotal+=sign*subtotal;total.paid+=sign*paid;total.due+=sign*due;totals.set(currency,total);
      rows.push([String(doc.occurredAt||'').slice(0,10),doc.documentNumber||'—',TYPES[doc.documentType],currency,decimalString(subtotal),decimalString(paid),decimalString(due)]);
    }
    rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    const report=table(sale?'كشف المبيعات والمرتجعات':'كشف المشتريات والمرتجعات',['التاريخ','الفاتورة','النوع','العملة','الصافي','المدفوع مع الفاتورة','المتبقي المسجل'],rows);
    const summary=table(sale?'إجماليات المبيعات':'إجماليات المشتريات',['العملة','عدد المستندات','عدد المرتجعات','صافي بعد المرتجعات','المدفوع بعد المرتجعات','المتبقي بعد المرتجعات'],[...totals].map(([currency,t])=>[currency,t.count,t.returns,decimalString(t.subtotal),decimalString(t.paid),decimalString(t.due)]));
    return {...result(`قرأت ${docs.length} مستندًا خلال ${period.label}. طرحت المرتجعات وجمعت كل عملة منفصلة. المدفوع هنا هو المسجل مع الفاتورة؛ راجع كشف العميل للتسديدات اللاحقة.`,report),reports:[summary]};
  }

  if(intent==='financial-movements'){
    if(!has('accounting.read'))return fail(403,'PERMISSION_DENIED','تحتاج صلاحية قراءة الحسابات');
    if(!source('listEnterpriseData'))return fail(501,'ASSISTANT_DATA_SOURCE_UNAVAILABLE','مصدر القيود غير متاح');
    const data=await store.listEnterpriseData(companyId,auth),accounts=new Map((data.chartAccounts||[]).map(a=>[a.code,a.name])),totals=new Map();
    // listEnterpriseData is filtered by the read-only facade, including linked documents.
    const journals=(data.journals||[]).filter(j=>j.status==='posted'&&(j.companyId==null||localRow(j))&&inPeriod(j.occurredAt));
    const rows=[];
    for(const j of journals)for(const line of j.lines||[]){
      const code=line.accountCode||line.account,currency=j.currency||auth.company.currency,debit=decimal(line.debit||'0'),credit=decimal(line.credit||'0');
      const t=totals.get(currency)||{debit:0n,credit:0n};t.debit+=debit;t.credit+=credit;totals.set(currency,t);
      rows.push([String(j.occurredAt||'').slice(0,10),j.entryNumber||'—',j.description||'—',code,accounts.get(code)||'—',currency,decimalString(debit),decimalString(credit)]);
    }
    rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    return {...result(`كشف الحركات المالية من ${journals.length} قيد منشور خلال ${period.label} ضمن نطاق حسابك. القيود غير المنشورة مستبعدة؛ لا تعني حركة الأستاذ تدفقًا نقديًا.`,table('الحركات المالية المنشورة',['التاريخ','القيد','البيان','رمز الحساب','الحساب','العملة','مدين','دائن'],rows)),reports:[table('إجماليات الحركات المالية',['العملة','المدين','الدائن','الفرق'],[...totals].map(([c,t])=>[c,decimalString(t.debit),decimalString(t.credit),decimalString(t.debit-t.credit)]))]};
  }

  if(intent==='customer-list'){
    if(!has('customers.read'))return fail(403,'PERMISSION_DENIED','تحتاج صلاحية قراءة العملاء');
    if(!source('listMasterData'))return fail(501,'ASSISTANT_DATA_SOURCE_UNAVAILABLE','دليل العملاء غير متاح');
    const master=await store.listMasterData(companyId);
    const rows=(master.customers||[]).filter(c=>(c.companyId==null||localRow(c))&&(!salesScoped||(store.salesSettings?.get('customer:'+c.id)?.channel||'retail')===channel))
      .map(c=>[c.code||'—',c.name||'—',c.phone||'—',c.province||'—',c.district||'—',c.address||'—',c.active===false?'موقوف':'نشط']);
    return result(`دليل ${rows.length} عميل ضمن صلاحياتك. لا يحتوي هذا الكشف أرصدة مالية.`,table('بيانات العملاء',['الرمز','العميل','الهاتف','المحافظة','المنطقة','العنوان','الحالة'],rows));
  }

  if(!['inventory-counts','stock-alerts','inventory-movements'].includes(intent))return null;
  if(!has('inventory.read')||!has('catalog.read'))return fail(403,'PERMISSION_DENIED','تحتاج صلاحية قراءة المخزون ودليل الأصناف');
  if(!source('listMasterData'))return fail(501,'ASSISTANT_DATA_SOURCE_UNAVAILABLE','مصدر المخزون غير متاح');
  const master=await store.listMasterData(companyId),items=new Map((master.items||[]).map(i=>[i.id,i])),units=new Map((master.units||[]).map(u=>[u.id,u.name||u.code])),warehouseNames=new Map((master.warehouses||[]).map(w=>[w.id,w.name||w.code]));

  if(intent==='inventory-counts'){
    if(!(store.stocktakes instanceof Map))return fail(501,'ASSISTANT_DATA_SOURCE_UNAVAILABLE','سجل الجرد غير متاح في هذا الخادم');
    const counts=[...store.stocktakes.values()].filter(c=>localRow(c)&&c.status==='posted'&&canSeeWarehouse(c.warehouseId)&&inPeriod(c.countedAt));
    const rows=counts.flatMap(c=>(c.lines||[]).map(line=>{
      const item=items.get(line.itemId),book=decimal(line.book||'0'),counted=decimal(line.counted??line.countedQuantity??'0'),delta=counted-book;
      return [String(c.countedAt||'').slice(0,10),c.stocktakeNumber||'—',warehouseNames.get(c.warehouseId)||'—',item?.sku||'—',item?.name||line.itemId,decimalString(book),decimalString(counted),decimalString(delta),delta===0n?'متطابق':'فرق جرد يحتاج مراجعة'];
    }));
    return result(`كشف ${counts.length} جرد منشور خلال ${period.label}. الفروقات محسوبة من العدد الفعلي والرصيد الدفتري وقت الجرد؛ لم أسجل تسوية.`,table('كشوف الجرد والفروقات',['التاريخ','الجرد','المخزن','الكود','الصنف','الدفتري','الفعلي','الفرق','الملاحظة'],rows));
  }

  if(intent==='stock-alerts'){
    const rows=[];
    for(const stock of (master.stock||[]).filter(s=>canSeeWarehouse(s.warehouseId))){
      const item=items.get(stock.itemId);if(item?.active===false)continue;
      try{
        const quantity=decimal(stock.quantity||'0');
        if(quantity<=0n)rows.push([quantity<0n?'خطأ محتمل':'تنبيه',warehouseNames.get(stock.warehouseId)||'—',item?.sku||'—',item?.name||stock.itemId,decimalString(quantity),quantity<0n?'رصيد سالب؛ راجع المستندات والجرد':'نفاد الرصيد المسجل']);
      }catch{rows.push(['خطأ محتمل',warehouseNames.get(stock.warehouseId)||'—',item?.sku||'—',item?.name||stock.itemId,String(stock.quantity),'رصيد غير صالح']);}
    }
    return {...result(`ظهرت ${rows.length} ملاحظة في أرصدة المخزون الحالية. لا أفترض حد إعادة طلب غير مسجل، ولا أرسل إشعارات خارج التطبيق أو أغيّر الأرصدة.`,table('تنبيهات المخزون الحالية',['الحالة','المخزن','الكود','الصنف','الرصيد','الملاحظة'],rows)),findingCount:rows.length};
  }

  // Quantity movement only: never expose purchase costs to a sales-only user.
  const rows=[];
  const add=(date,ref,type,warehouseId,line,sign)=>{
    if(!canSeeWarehouse(warehouseId)||!inPeriod(date))return;
    const item=items.get(line.itemId),unit=item?.units?.find(u=>u.unitId===line.unitId);
    const base=line.baseQuantity!=null?decimal(line.baseQuantity):decimal(line.quantity||'0')*decimal(unit?.conversionFactor||'1')/1000000n;
    rows.push([String(date||'').slice(0,10),ref||'—',type,warehouseNames.get(warehouseId)||'—',item?.sku||'—',item?.name||line.itemId,units.get(item?.baseUnitId)||'—',decimalString(sign>0n?base:0n),decimalString(sign<0n?base:0n),decimalString(sign*base)]);
  };
  if(source('listCommerceDocuments'))for(const doc of await store.listCommerceDocuments(companyId)){
    if(!visibleDoc(doc)||!TYPES[doc.documentType]||!(doc.documentType.startsWith('sale')?has('sales.read'):has('purchasing.read')))continue;
    for(const line of doc.lines||[])add(doc.occurredAt,doc.documentNumber,TYPES[doc.documentType],doc.warehouseId,line,['purchase','sale_return'].includes(doc.documentType)?1n:-1n);
  }
  for(const [name,type,sign] of [['stockReceipts','إدخال مخزني',1n],['stockIssues','إخراج مخزني',-1n]])for(const row of store[name]?.values()||[]){
    if(!localRow(row)||row.status!=='posted')continue;
    for(const line of row.lines||[])add(row.occurredAt,row.voucherNumber,type,line.warehouseId||row.warehouseId,{...line,baseQuantity:line.quantity},sign);
  }
  for(const row of store.stockTransfers?.values()||[]){
    if(!localRow(row)||row.status!=='posted')continue;
    for(const line of row.lines||[]){add(row.occurredAt,row.transferNumber,'تحويل خارج',row.sourceWarehouseId,{...line,baseQuantity:line.quantity},-1n);add(row.occurredAt,row.transferNumber,'تحويل داخل',row.destinationWarehouseId,{...line,baseQuantity:line.quantity},1n);}
  }
  for(const count of store.stocktakes?.values()||[]){
    if(!localRow(count)||count.status!=='posted')continue;
    for(const line of count.lines||[]){const delta=decimal(line.delta??decimalString(decimal(line.counted??line.countedQuantity??'0')-decimal(line.book||'0')));add(count.countedAt,count.stocktakeNumber,'تسوية جرد',count.warehouseId,{...line,baseQuantity:decimalString(delta<0n?-delta:delta)},delta<0n?-1n:1n);}
  }
  for(const loss of store.stockWriteoffs?.values()||[])if(localRow(loss)&&(loss.status==null||loss.status==='posted'))add(loss.occurredAt,loss.writeoffNumber,'تالف',loss.warehouseId,{...loss,baseQuantity:loss.quantity},-1n);
  rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return result(`حركة البضاعة خلال ${period.label}: ${rows.length} سطر، بوحدات الأصناف الأساسية. يشمل المستندات المقروءة والإدخال والإخراج والتحويل والجرد والتالف المتاحة في هذا الخادم؛ لا يشمل مصادر أو مخازن خارج صلاحياتك.`,table('حركة البضاعة والمخزون',['التاريخ','المستند','الحركة','المخزن','الكود','الصنف','الوحدة الأساسية','وارد','صادر','الأثر'],rows));
}
