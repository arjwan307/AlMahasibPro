import { AppError } from '../../lib/http.js';
import { decimal, decimalString } from '../../lib/decimal.js';
import { payloadHash } from '../../lib/security.js';

const fields = {
  customers: ['code','name','phone','openingBalance','currency'],
  suppliers: ['code','name','phone','openingBalance','currency'],
  items: ['sku','name','unitCode','description']
};
const fail = (code, message, status = 400) => { throw new AppError(status, code, message); };
const phoneKey = value => String(value || '').replace(/[٠-٩]/g,digit=>String(digit.charCodeAt(0)-0x0660)).replace(/[۰-۹]/g,digit=>String(digit.charCodeAt(0)-0x06f0)).replace(/[^0-9+]/g,'');
export function assertImportScope(store, context, entity, branchId) {
  if (!store.transaction || !store.dataImportBatches) fail('IMPORT_STORE_UNSUPPORTED','الاستيراد الذري متاح حاليًا في قاعدة SQLite المحلية',501);
  const permission = {customers:'customers.manage',suppliers:'suppliers.manage',items:'catalog.manage'}[entity];
  if (!permission || !context.permissions.includes('company.manage') || !context.permissions.includes(permission)) fail('PERMISSION_DENIED','الاستيراد يتطلب صلاحية إدارة الشركة والبيانات المختارة',403);
  // Master records are company-wide in the current domain model. A restricted
  // branch/warehouse/representative account must never gain access through import.
  if ((context.scopes || []).some(scope => scope.type !== 'company')) fail('IMPORT_SCOPE_DENIED','استيراد البيانات المشتركة يتطلب حسابًا بنطاق الشركة',403);
  const company = store.companies.get(context.company.id);
  if (!company || !company.branches?.some(branch => branch.id === branchId && branch.active !== false)) fail('BRANCH_NOT_FOUND','اختر فرعًا فعالًا من الشركة الحالية',404);
}
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u001f]/.test(value)) fail('INVALID_FIELD','قيمة نصية غير صالحة');
  return value.trim().normalize('NFKC');
};
function money(value) {
  // Financial imports require an unambiguous decimal, never guess separators.
  const raw = String(value ?? '0');
  if (!/^-?\d{1,13}(?:\.\d{1,6})?$/.test(raw)) fail('INVALID_AMOUNT','استخدم رقمًا عشريًا بنقطة دون فواصل آلاف');
  return decimalString(decimal(raw));
}
export function normalizeImportRows(entity, rows, mapping) {
  if (!fields[entity] || !Array.isArray(rows) || !rows.length || rows.length > 5000 || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail('INVALID_IMPORT','بيانات الاستيراد غير صالحة');
  const required = entity === 'items' ? ['sku','name','unitCode'] : ['code','name'];
  if (Object.keys(mapping).some(key => !fields[entity].includes(key)) || required.some(key => !mapping[key]) || new Set(Object.values(mapping)).size !== Object.values(mapping).length) fail('INVALID_MAPPING','مطابقة الأعمدة غير صالحة');
  return rows.map((source, index) => {
    if (Object.keys(source).some(key => /^(company|tenant|branch|user|id)([_-]?id)?$/i.test(key.replace(/\s/g,'')))) fail('SOURCE_IDENTITY_FORBIDDEN','احذف أعمدة هوية الشركة والفرع والمعرفات من المصدر');
    const row = {};
    for (const [field, column] of Object.entries(mapping)) {
      if (typeof column !== 'string' || !Object.hasOwn(source,column)) fail('INVALID_MAPPING',`عمود غير موجود في السطر ${index + 2}`);
      row[field] = source[column];
    }
    const result = {name:text(row.name,160,true)};
    if (entity === 'items') {
      result.sku = text(row.sku,64,true).toUpperCase();
      result.unitCode = text(row.unitCode,64,true).toUpperCase();
      result.description = text(row.description ?? '',2000);
    } else {
      result.code = text(row.code,64,true).toUpperCase();
      result.phone = text(row.phone ?? '',32);
      if (result.phone && !/^[+\d٠-٩۰-۹ ()-]+$/.test(result.phone)) fail('INVALID_PHONE','رقم الهاتف غير صالح');
      result.openingBalance = money(row.openingBalance ?? '0');
      result.currency = text(row.currency ?? 'IQD',3,true).toUpperCase();
      if (!['IQD','USD'].includes(result.currency)) fail('INVALID_CURRENCY','العملة غير مدعومة');
    }
    if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(result.code || result.sku)) fail('INVALID_CODE','الرمز يجب أن يكون حروفًا لاتينية وأرقامًا وشرطة أو نقطة');
    return result;
  });
}
export function inspectImport(store, context, input) {
  assertImportScope(store,context,input.entity,input.branchId);
  const companyId = context.company.id, map = store[input.entity];
  const existing = [...map.values()].filter(row => row.companyId === companyId);
  const seen = new Set(), phones = new Set(), issues = [], totals = {};
  const keyField = input.entity === 'items' ? 'sku' : 'code';
  const rows = input.rows.map((row, index) => {
    const key = row[keyField], phone = phoneKey(row.phone);
    const duplicate = seen.has(key) || existing.some(record => String(record[keyField]).normalize('NFKC').toUpperCase() === key);
    if (duplicate) issues.push({row:index+2,code:'DUPLICATE_CODE'});
    seen.add(key);
    if (phone && (phones.has(phone) || existing.some(record => phoneKey(record.phone) === phone))) issues.push({row:index+2,code:'DUPLICATE_PHONE'});
    if (phone) phones.add(phone);
    if (input.entity === 'items') {
      const unit = [...store.units.values()].find(unit => unit.companyId === companyId && unit.active !== false && unit.code.toUpperCase() === row.unitCode);
      if (!unit) issues.push({row:index+2,code:'UNIT_NOT_FOUND'});
      return {...row,baseUnitId:unit?.id || null};
    }
    const amount = decimal(row.openingBalance);
    const summary = totals[row.currency] ||= {net:0n,debit:0n,credit:0n};
    summary.net += amount;
    if (amount >= 0n) summary.debit += amount; else summary.credit -= amount;
    return row;
  });
  const balances = Object.fromEntries(Object.entries(totals).map(([currency,total]) => [currency,Object.fromEntries(Object.entries(total).map(([key,value]) => [key,decimalString(value)]))]));
  if (input.entity !== 'items') {
    if (!input.expectedBalances || typeof input.expectedBalances !== 'object' || Array.isArray(input.expectedBalances) || Object.keys(input.expectedBalances).sort().join() !== Object.keys(balances).sort().join()) fail('EXPECTED_BALANCES_REQUIRED','أدخل المجاميع المستقلة لكل عملة للمطابقة');
    for (const [currency, summary] of Object.entries(balances)) {
      const expected = input.expectedBalances[currency];
      if (!expected || Object.keys(expected).sort().join() !== 'credit,debit,net') fail('EXPECTED_BALANCES_REQUIRED','أدخل الصافي وإجمالي المدين والدائن لكل عملة');
      if (Object.keys(summary).some(key => money(expected[key]) !== summary[key])) issues.push({currency,code:'BALANCE_MISMATCH'});
    }
  }
  const hasBalance = rows.some(row => row.openingBalance && decimal(row.openingBalance) !== 0n);
  if (hasBalance && !context.permissions.includes('accounting.post')) fail('PERMISSION_DENIED','إثبات الأرصدة يتطلب صلاحية الترحيل المحاسبي',403);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.openingDate || '') || !Number.isFinite(Date.parse(input.openingDate)) || new Date(input.openingDate).toISOString().slice(0,10) !== input.openingDate) fail('INVALID_DATE','تاريخ الرصيد غير صالح');
  if (hasBalance) store.assertFinancialPeriod(companyId,input.openingDate+'T00:00:00.000Z');
  // Bind approval to normalized content and resolved target references.
  const hash = payloadHash({entity:input.entity,branchId:input.branchId,openingDate:input.openingDate,rows,balances,issues});
  return {rows,balances,issues,hash,canCommit:issues.length===0};
}
