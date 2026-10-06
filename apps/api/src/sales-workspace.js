import { randomUUID } from 'node:crypto';
import { AppError, asyncRoute } from './lib/http.js';
import { decimal, decimalString, multiply, divide, ZERO } from './lib/decimal.js';
import { payloadHash } from './lib/security.js';
export const salesRep = c => c.roles?.some(r=>r.code==='representative') && !c.permissions.includes('company.manage');
const fail=(code,message)=>{throw new AppError(409,code,message);};
const profile=(s,c)=>s.salesSettings.get('user:'+c.user.id)||{channel:'retail',phone:'',location:'',maxDiscountPercent:'0'};
const setting=(s,type,id)=>s.salesSettings.get(type+':'+id)||{};
const channelName=x=>x==='wholesale'?'جملة':'مفرد';
const fp=d=>payloadHash({...d,approvalId:null});
export function checkSales(s,c,d){
 if(d.documentType!=='sale'||!salesRep(c))return null;
 const p=profile(s,c), cid=c.company.id, reasons=[];
 const customer=s.customers.get(d.partyId);
 if(!customer||customer.companyId!==cid||(setting(s,'customer',customer.id).channel||'retail')!==p.channel)fail('CUSTOMER_SCOPE','اختر زبونًا من نوع مبيعاتك');
 const warehouse=s.warehouses.get(d.warehouseId);
 if(!warehouse||warehouse.companyId!==cid||setting(s,'warehouse',warehouse.id).damaged)fail('DAMAGED_WAREHOUSE','مخزن الأضرار غير متاح للبيع');
 let gross=ZERO;
 for(const line of d.lines){
  const item=s.items.get(line.itemId), cfg=setting(s,'item',line.itemId);
  if(!item||item.companyId!==cid||!item.active)fail('ITEM_NOT_FOUND','الصنف غير متاح');
  const prices=[...s.prices.values()].filter(x=>x.companyId===cid&&x.itemId===item.id&&x.unitId===line.unitId&&x.currency===d.currency&&x.active);
  const price=prices.filter(x=>x.priceType==='sale_'+p.channel).at(-1)||prices.filter(x=>x.priceType==='sale').at(-1);
  if(!price)fail('PRICE_REQUIRED','حدد سعر '+channelName(p.channel)+' للصنف '+item.name);
  if(decimal(line.unitPrice)!==decimal(price.amount))fail('PRICE_CHANGED','سعر الصنف تغيّر أو لا يطابق سعر '+channelName(p.channel));
  gross+=multiply(decimal(line.quantity,{positive:true}),decimal(line.unitPrice,{nonNegative:true}));
  if(cfg.channel&&cfg.channel!=='both'&&cfg.channel!==p.channel)reasons.push('بيع '+item.name+' خارج نوع المندوب');
  const relation=[...s.itemUnits.values()].find(x=>x.companyId===cid&&x.itemId===item.id&&x.unitId===line.unitId);
  if(!relation)fail('ITEM_UNIT_NOT_FOUND','الوحدة غير موجودة');
  const qty=multiply(decimal(line.quantity,{positive:true}),decimal(relation.conversionFactor));
  const stock=s.stockBalances.get(cid+':'+warehouse.id+':'+item.id);
  const reserved=decimal(cfg.reserved?.[warehouse.id]||'0',{nonNegative:true});
  if(decimal(stock?.quantity||'0')-reserved<qty)reasons.push('رفع حجز '+item.name);
 }
 const discount=decimal(d.discountAmount||'0',{nonNegative:true});
 for(const line of d.lines){const cfg=setting(s,'item',line.itemId);if(cfg.maxDiscountPercent!=null&&discount>multiply(gross,divide(decimal(cfg.maxDiscountPercent),decimal('100'))))reasons.push('تجاوز خصم المادة '+s.items.get(line.itemId).name);}
 if(discount>gross)fail('DISCOUNT_EXCEEDS_TOTAL','الخصم يتجاوز الإجمالي');
 if(discount>multiply(gross,divide(decimal(p.maxDiscountPercent||'0'),decimal('100'))))reasons.push('تجاوز حد الخصم');
 const approval=d.approvalId?s.salesApprovals.get(d.approvalId):null;
 if(reasons.length&&(!approval||approval.companyId!==cid||approval.userId!==c.user.id||approval.profile.channel!==p.channel||approval.status!=='approved'||approval.fingerprint!==fp(d)))fail('MANAGER_APPROVAL_REQUIRED','تحتاج موافقة المدير: '+reasons.join('، '));
 return reasons.length?approval:null;
}
export function salesReasons(s,c,d){try{checkSales(s,c,{...d,approvalId:null});return [];}catch(e){if(e.code==='MANAGER_APPROVAL_REQUIRED')return [e.message];throw e;}}
export function installSalesRoutes(app,{store:s,authenticate,permit,validateDocument}){
 const auth=authenticate(s), known=(map,c,id)=>{const row=map.get(id);if(!row||row.companyId!==c.company.id)throw new AppError(404,'NOT_FOUND','السجل غير موجود');return row;};
 const supported=(req,res,next)=>{if(!s.salesSettings) return next(new AppError(501,'SQLITE_REQUIRED','هذه الواجهة تحتاج قاعدة SQLite'));next();};
 app.get('/api/v1/sales/bootstrap',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const c=req.auth,p=profile(s,c),rep=salesRep(c),m=await s.listMasterData(c.company.id),data=await s.listEnterpriseData(c.company.id);
  const customers=m.customers.filter(x=>!rep||(setting(s,'customer',x.id).channel||'retail')===p.channel).map(x=>({...x,...setting(s,'customer',x.id)}));
  const ids=new Set(customers.map(x=>x.id));
  const documents=(await s.listCommerceDocuments(c.company.id)).filter(x=>!rep||(x.documentType.startsWith('sale')&&ids.has(x.customerId)));
  const prices=m.prices.filter(x=>!rep||['sale_'+p.channel,'sale'].includes(x.priceType));
  res.json({personalCards:setting(s,'board',c.user.id).cards||[],userProfiles:!c.permissions.includes('users.manage')?{}:Object.fromEntries([...s.salesSettings].filter(([k,v])=>k.startsWith('user:')&&v.companyId===c.company.id)),profile:p,representative:rep,customers,items:m.items.map(x=>({...x,...setting(s,'item',x.id)})),units:m.units,prices,warehouses:m.warehouses.map(x=>({...x,...setting(s,'warehouse',x.id)})),stock:m.stock.map(({averageCost,...x})=>x),documents:documents.map(x=>({...x,lines:x.lines.map(({unitCost,...line})=>line)})),settlements:(data.settlements||[]).filter(x=>documents.some(d=>d.id===x.documentId)),approvals:[...s.salesApprovals.values()].filter(x=>x.companyId===c.company.id&&(!rep||x.userId===c.user.id)),reviews:[...s.salesReviews.values()].filter(x=>x.companyId===c.company.id&&(!rep||x.userId===c.user.id))});
 }));
 app.put('/api/v1/sales/personal-board',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const rows=req.body.cards;if(!Array.isArray(rows)||rows.length>100)throw new AppError(400,'INVALID_BOARD','الحد الأقصى ١٠٠ بطاقة');
  const ids=new Set();const cards=rows.map(x=>{if(typeof x.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(x.id)||ids.has(x.id)||!['note','reminder'].includes(x.kind)||typeof x.text!=='string'||!x.text.trim()||x.text.length>2000)throw new AppError(400,'INVALID_CARD','بطاقة غير صالحة');ids.add(x.id);let dueAt=null;if(x.kind==='reminder'){if(!x.dueAt||!Number.isFinite(Date.parse(x.dueAt)))throw new AppError(400,'INVALID_REMINDER','حدد موعد التذكير');dueAt=new Date(x.dueAt).toISOString();}return {id:x.id,kind:x.kind,text:x.text.trim(),dueAt,done:x.done===true};});
  await s.saveSalesSetting('board:'+req.auth.user.id,{companyId:req.auth.company.id,cards},req.auth.user.id);res.json({cards});
 }));
 for(const [type,map,permission] of [['user','users','users.manage'],['customer','customers','customers.manage'],['item','items','catalog.manage'],['warehouse','warehouses','inventory.manage']]){
  app.put('/api/v1/sales/settings/'+type+'/:id',auth,permit(permission),supported,asyncRoute(async(req,res)=>{
   known(s[map],req.auth,req.params.id);const b=req.body,cfg={companyId:req.auth.company.id};
   if(['user','customer'].includes(type)){if(!['retail','wholesale'].includes(b.channel))throw new AppError(400,'INVALID_CHANNEL','حدد مفرد أو جملة');cfg.channel=b.channel;}
   if(type==='user'){cfg.phone=String(b.phone||'').slice(0,40);cfg.location=String(b.location||'').slice(0,200);cfg.maxDiscountPercent=decimalString(decimal(b.maxDiscountPercent||'0',{nonNegative:true}));if(decimal(cfg.maxDiscountPercent)>decimal('100'))throw new AppError(400,'INVALID_DISCOUNT','الخصم لا يتجاوز ١٠٠٪');}
   if(type==='customer'){for(const k of ['governorate','district','neighborhood'])cfg[k]=String(b[k]||'').slice(0,120);if(!['green','yellow','red'].includes(b.risk))throw new AppError(400,'INVALID_RISK','التصنيف غير صالح');cfg.risk=b.risk;}
   if(type==='item'){if(!['both','retail','wholesale'].includes(b.channel)||!['slow','moving','strong'].includes(b.movement))throw new AppError(400,'INVALID_ITEM_POLICY','تصنيف المادة غير صالح');cfg.channel=b.channel;cfg.movement=b.movement;cfg.maxDiscountPercent=decimalString(decimal(b.maxDiscountPercent||'0',{nonNegative:true}));if(decimal(cfg.maxDiscountPercent)>decimal('100'))throw new AppError(400,'INVALID_DISCOUNT','الخصم لا يتجاوز ١٠٠٪');cfg.reserved={...(setting(s,type,req.params.id).reserved||{})};if(b.warehouseId){known(s.warehouses,req.auth,b.warehouseId);cfg.reserved[b.warehouseId]=decimalString(decimal(b.reservedQuantity||'0',{nonNegative:true}));}}
   if(type==='warehouse')cfg.damaged=b.damaged===true;
   await s.saveSalesSetting(type+':'+req.params.id,cfg,req.auth.user.id);res.json({setting:cfg});
  }));
 }
 app.post('/api/v1/sales/walk-in',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const b=req.body,name=String(b.name||'').trim();if(!name||name.length>120)throw new AppError(400,'NAME_REQUIRED','اسم الزبون مطلوب');const customer=await s.createParty(req.auth.company.id,'customer',{code:'WALK-'+randomUUID(),name,phone:String(b.phone||'').slice(0,40),creditLimit:'0'},req.auth.user.id);const cfg={companyId:req.auth.company.id,channel:salesRep(req.auth)?profile(s,req.auth).channel:(b.channel==='wholesale'?'wholesale':'retail'),neighborhood:String(b.address||'').slice(0,120),risk:'green',oneTime:true};await s.saveSalesSetting('customer:'+customer.id,cfg,req.auth.user.id);res.status(201).json({customer:{...customer,...cfg}});
 }));
 app.post('/api/v1/sales/approvals',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  if(!salesRep(req.auth))throw new AppError(400,'REP_REQUIRED','طلب الموافقة خاص بالمندوب');const document=validateDocument(req.body.document),reasons=salesReasons(s,req.auth,document);if(!reasons.length)throw new AppError(400,'APPROVAL_NOT_REQUIRED','الفاتورة ضمن الصلاحيات');
  const row={id:randomUUID(),companyId:req.auth.company.id,userId:req.auth.user.id,userName:req.auth.user.displayName,profile:profile(s,req.auth),document:{...document,approvalId:null},fingerprint:fp(document),reasons,status:'pending',createdAt:new Date().toISOString()};await s.saveSalesApproval(row);res.status(201).json({approval:row});
 }));
 app.post('/api/v1/sales/approvals/:id/decision',auth,permit('company.manage'),supported,asyncRoute(async(req,res)=>{
  const old=known(s.salesApprovals,req.auth,req.params.id);if(old.status!=='pending')fail('ALREADY_DECIDED','تمت مراجعة الطلب');if(!['approved','rejected'].includes(req.body.status))throw new AppError(400,'INVALID_DECISION','قرار غير صالح');const row={...old,status:req.body.status,reviewedBy:req.auth.user.id,reviewedAt:new Date().toISOString()};await s.saveSalesApproval(row);res.json({approval:row});
 }));
 app.post('/api/v1/sales/customer-review',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const customer=known(s.customers,req.auth,req.body.customerId);if(salesRep(req.auth)&&(setting(s,'customer',customer.id).channel||'retail')!==profile(s,req.auth).channel)throw new AppError(403,'CUSTOMER_SCOPE','الزبون خارج صلاحيتك');const row={id:randomUUID(),companyId:req.auth.company.id,userId:req.auth.user.id,userName:req.auth.user.displayName,customerId:customer.id,customerName:customer.name,createdAt:new Date().toISOString()};await s.saveSalesReview(row);res.status(201).json({review:row});
 }));
}
