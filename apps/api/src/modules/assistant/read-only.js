import {decimal,decimalString} from '../../lib/decimal.js';

// The assistant receives only read methods and detached copies of domain maps.
// No accounting, inventory, catalog, messaging or persistence method is exposed.
const METHODS = ['listMasterData','listCommerceDocuments','listEnterpriseData','listCustomerAccountSummaries','listPermissionDenials','listChartAccounts','trialBalance'];
const MAPS = ['warehouses','salesSettings','stocktakes','stockWriteoffs','stockReceipts','stockIssues','stockTransfers','deliveryLoads','financialRecords','debtMovements','representativeCollections'];

export function assistantReadStore(source, auth) {
  const view = Object.create(null);
  const snapshots = new Map();
  for (const name of METHODS) if (typeof source?.[name] === 'function') {
    view[name] = async (...args) => {
      if (auth?.company?.id && args[0] !== auth.company.id) throw new Error('ASSISTANT_COMPANY_SCOPE');
      const key = name+':'+JSON.stringify(args);
      if (!snapshots.has(key)) snapshots.set(key,Promise.resolve(source[name](...args)).then(value=>structuredClone(value)));
      const result=structuredClone(await snapshots.get(key));
      if(name==='listEnterpriseData'&&auth?.company?.id){
        const branches=(auth.scopes||[]).filter(s=>s.type==='branch').map(s=>s.id),warehouses=(auth.scopes||[]).filter(s=>s.type==='warehouse').map(s=>s.id);
        const scoped=branches.length||warehouses.length;
        const allowed=row=>{
          if(row.companyId!=null&&row.companyId!==auth.company.id)return false;
          if(!scoped)return true;
          const doc=source.commerceDocuments?.get?.(row.documentId),warehouseId=row.warehouseId||doc?.warehouseId;
          const warehouse=source.warehouses?.get?.(warehouseId),branchId=row.branchId||doc?.branchId||warehouse?.branchId;
          return (!branches.length||branches.includes(branchId))&&(!warehouses.length||warehouses.includes(warehouseId));
        };
        result.journals=(result.journals||[]).filter(allowed);
        if(scoped){
          const chart=new Map((result.chartAccounts||[]).map(a=>[a.code,a])),totals=new Map();
          for(const j of result.journals.filter(j=>j.status==='posted'))for(const line of j.lines||[]){
            const code=line.accountCode||line.account,currency=j.currency||auth.company.currency,key=code+':'+currency;
            const row=totals.get(key)||{accountCode:code,name:chart.get(code)?.name||code,currency,debit:0n,credit:0n};
            try{row.debit+=decimal(line.debit||'0');row.credit+=decimal(line.credit||'0');totals.set(key,row);}catch{result.trialBalanceError=true;}
          }
          result.trialBalance=result.trialBalanceError?[]:[...totals.values()].map(row=>({...row,debit:decimalString(row.debit),credit:decimalString(row.credit),balance:decimalString(row.debit-row.credit)}));
          result.settlements=(result.settlements||[]).filter(allowed);
        }
      }
      return result;
    };
  }
  for (const name of MAPS) if (source?.[name] instanceof Map) {
    let snapshot;
    Object.defineProperty(view, name, { get() {
      if(snapshot)return snapshot;
      const branches=(auth?.scopes||[]).filter(s=>s.type==='branch').map(s=>s.id),warehouses=(auth?.scopes||[]).filter(s=>s.type==='warehouse').map(s=>s.id);
      const scopedFinancial=['financialRecords','debtMovements','representativeCollections'].includes(name)&&(branches.length||warehouses.length);
      snapshot=new Map([...source[name]].filter(([,row])=>{
        if(row.companyId!=null&&auth?.company?.id&&row.companyId!==auth.company.id)return false;
        if(!scopedFinancial)return true;
        const doc=source.commerceDocuments?.get?.(row.documentId),warehouseId=row.warehouseId||doc?.warehouseId;
        const branchId=row.branchId||doc?.branchId||source.warehouses?.get?.(warehouseId)?.branchId;
        return (!branches.length||branches.includes(branchId))&&(!warehouses.length||warehouses.includes(warehouseId));
      }).map(([key,row])=>[key,structuredClone(row)]));
      return snapshot;
    } });
  }
  return Object.freeze(view);
}

const tool = (id, label, prompt, all = [], any = []) => ({ id, label, prompt, all, any });
export const ASSISTANT_READ_TOOLS = [
  tool('review-summary','مراجعة شاملة','مراجعة شاملة وتنبيهات',[],['accounting.read','catalog.read','inventory.read','sales.read','purchasing.read']),
  tool('journal-audit','مراجعة القيود','راجع القيود',['accounting.read']),
  tool('price-audit','مراجعة الأسعار','راجع الأسعار',['catalog.read']),
  tool('invoice-audit','مراجعة الفواتير','راجع الفواتير',[],['sales.read','purchasing.read']),
  tool('stock-balance','كشف المخزون','كشف المخزون',['inventory.read']),
  tool('inventory-movements','حركة البضاعة','حركة المخزون',['inventory.read','catalog.read']),
  tool('inventory-counts','تقارير الجرد','كشف الجرد',['inventory.read','catalog.read']),
  tool('stock-alerts','تنبيهات المخزون','تنبيهات المخزون',['inventory.read','catalog.read']),
  tool('sales-report','تقرير المبيعات','تقرير المبيعات',['sales.read']),
  tool('purchase-report','تقرير المشتريات','تقرير المشتريات',['purchasing.read']),
  tool('financial-movements','الحركات المالية','كشف الحركات المالية',['accounting.read']),
  tool('income-expense-report','الإيرادات والمصروفات','كشف الإيرادات والمصروفات',['accounting.read']),
  tool('customer-list','دليل العملاء','كشف بيانات العملاء',['customers.read']),
  tool('customer-statement','كشف حساب عميل','كشف حساب العميل',['customers.read','sales.read','accounting.read']),
  tool('customer-reconciliation','مراجعة العملاء','راجع حسابات الزبائن',['customers.read','sales.read','accounting.read']),
  tool('trial-balance','ميزان المراجعة','ميزان المراجعة',['accounting.read'])
];
export function assistantTools(auth) {
  const has = permission => auth?.permissions?.includes(permission);
  if (!has('assistant.use')) return [];
  return ASSISTANT_READ_TOOLS.filter(t => t.all.every(has) && (!t.any.length || t.any.some(has)))
    .map(({id,label,prompt}) => ({id,label,prompt}));
}

export const normalizeAssistantText = value => String(value || '').normalize('NFKC')
  .replace(/[أإآ]/g,'ا').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/\s+/g,' ').trim();

export function assistantWriteRequest(message) {
  let text = normalizeAssistantText(message);
  // Journal creation is disabled even for users who can post through the ERP.
  if (/(?:انشئ|انشاء|اعد|جهز|اكتب|اقترح|اضف|سجل|رحل|اعتمد|احفظ)\s+(?:لي\s+)?(?:مسودة\s+)?قيد|مسودة\s+قيد/.test(text)) return true;
  // Creating a report is a read. Remove only that verb phrase, so a later
  // instruction to change/post records is still rejected.
  text=text.replace(/(?:انشئ|انشاء|اعد|جهز|اكتب)\s+(?:لي\s+)?(?:التقرير|التقارير|تقرير|تقارير|الكشف|الكشوف|كشف|كشوف|كشوفات)(?=\s|:|$)/g,'');
  if (/\b(?:create|post|commit|approve|delete|update|change|save|send|execute)\b.{0,60}\b(?:journal|entry|invoice|payment|stock|balance|price|customer|supplier|notification)\b/i.test(text)) return true;
  const verbs = '(?:انشئ|اضف|سجل|رحل|اعتمد|احفظ|عدل|غير|حدث|احذف|نفذ|ارسل|سو(?:ي)?|صحح|خفض|ارفع)';
  const entities = '(?:قيد|قيود|فاتورة|فواتير|سند|سندات|دفعة|دفعات|دفع|تسديد|تحصيل|رصيد|ارصدة|مخزون|كمية|كميات|سعر|اسعار|عميل|عملاء|زبون|زبائن|مورد|موردين|حركة|حركات|بيانات|اشعار|رسالة)';
  // Explicit non-journal previews may be inspected, but never have apply actions.
  if (/(?:مسودة|معاينة|اقتراح|مقترح)/.test(text) && !/(?:رحل|اعتمد|احفظ|احذف|نفذ|ارسل)/.test(text)) return false;
  return new RegExp('(?:^|\\s)'+verbs+'(?:\\s|:).{0,60}'+entities).test(text);
}
