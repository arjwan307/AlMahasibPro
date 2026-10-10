import { AppError } from './http.js';
export function requireMarketPermission(context,type){
 const permissions=context.permissions||[];
 const required=type==='market.snapshot'?'catalog.manage':({sale:'sales.create',return:'sales.return',cancel:'sales.return',shift_open:'pos.shift.open',shift_close:'pos.shift.close',expense:'accounting.post',cash_in:'accounting.post',collection:'customers.manage',waiting_update:'sales.create',waiting_close:'sales.create',drawer_open:'pos.shift.open',drawer_result:'pos.shift.open'})[type.replace('market.transaction.','')];
 if(!required||!permissions.includes(required))throw new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية لهذه العملية');
 // Legacy retail snapshots have no branch identifiers. Never expose or replace
 // company-wide data through an account restricted to a branch/warehouse.
 requireCompanyMarketScope(context);
}
export function requireCompanyMarketScope(context){if((context.scopes||[]).some(x=>['branch','warehouse'].includes(x.type)))throw new AppError(403,'MARKET_SCOPE_REQUIRED','بيانات الماركت العامة تحتاج نطاق الشركة؛ استخدم العمليات المنسوبة إلى فرعك');}
export function validateMarketCatalog(catalog){
 if(!Array.isArray(catalog)||catalog.length>10000)throw new AppError(400,'INVALID_MARKET_CATALOG','أرسل قائمة صحيحة حتى 10000 مادة؛ لم يُحفظ أي جزء من القائمة');
 const codes=new Set(),ids=new Set();
 return catalog.map(x=>{
  if(!x||typeof x!=='object')throw new AppError(400,'INVALID_MARKET_ITEM','بيانات المادة غير صالحة');
  const text=(key,max,required=false)=>{const value=String(x[key]??'').trim();if(value.length>max||(required&&!value))throw new AppError(400,'INVALID_MARKET_ITEM','بيانات المادة غير مكتملة أو تتجاوز الحد');return value};
  const id=text('id',128,true),name=text('name',200,true),barcode=text('barcode',64,true);
  if(ids.has(id)||codes.has(barcode))throw new AppError(400,'DUPLICATE_MARKET_ITEM','رمز المادة أو الباركود مكرر');ids.add(id);codes.add(barcode);
  const number=key=>{const value=x[key]??0;if((typeof value!=='number'&&typeof value!=='string')||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>1e12)throw new AppError(400,'INVALID_MARKET_NUMBER','السعر والتكلفة والرصيد يجب أن تكون أرقامًا غير سالبة ضمن الحد المسموح');return Number(value)};
  return {id,name,barcode,category:text('category',100)||'غير مصنف',unit:text('unit',32)||'قطعة',cost:number('cost'),price:number('price'),qty:number('qty'),minQty:number('minQty'),demo:x.demo===true};
 });
}
