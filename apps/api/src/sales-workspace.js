import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, asyncRoute } from './lib/http.js';
import { decimal, decimalString, multiply, divide, ZERO } from './lib/decimal.js';
import { payloadHash } from './lib/security.js';
export const salesRep = c => c.roles?.some(r=>r.code==='representative') && !c.permissions.includes('company.manage');
const fail=(code,message)=>{throw new AppError(409,code,message);};
export const salesScoped=(s,c)=>salesRep(c)||!!s.salesSettings?.get('user:'+c.user.id)?.salesManager;
export function assignedSalesManager(s,c){const p=profile(s,c);const candidates=[...s.users.values()].filter(u=>u.companyId===c.company.id&&u.status==='active'&&setting(s,'user',u.id).salesManager&&setting(s,'user',u.id).channel===p.channel);if(p.managerUserId){const selected=candidates.find(x=>x.id===p.managerUserId);if(!selected)fail('SALES_MANAGER_UNAVAILABLE','مدير المبيعات المعين غير متاح أو تغيّر نوعه');return selected.id;}if(candidates.length>1)fail('SALES_MANAGER_REQUIRED','حدد مدير المبيعات المعين للمندوب');return candidates[0]?.id||null;}
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
  if(decimal(line.unitPrice)!==decimal(price.amount))reasons.push('تعديل سعر '+item.name+' عن سعر '+channelName(p.channel));
  gross+=multiply(decimal(line.quantity,{positive:true}),decimal(line.unitPrice,{nonNegative:true}));
  if(cfg.channel&&cfg.channel!=='both'&&cfg.channel!==p.channel)reasons.push('بيع '+item.name+' خارج نوع المندوب');
  const relation=[...s.itemUnits.values()].find(x=>x.companyId===cid&&x.itemId===item.id&&x.unitId===line.unitId);
  if(!relation)fail('ITEM_UNIT_NOT_FOUND','الوحدة غير موجودة');
  const qty=multiply(decimal(line.quantity,{positive:true}),decimal(relation.conversionFactor));
  const lineWarehouse=line.warehouseId?s.warehouses.get(line.warehouseId):warehouse;if(!lineWarehouse||lineWarehouse.companyId!==cid||setting(s,'warehouse',lineWarehouse.id).damaged)fail('DAMAGED_WAREHOUSE','مخزن البند غير متاح للبيع');
  const stock=s.stockBalances.get(cid+':'+lineWarehouse.id+':'+item.id);
  const reserved=decimal(cfg.reserved?.[lineWarehouse.id]||'0',{nonNegative:true});
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
  const c=req.auth,p=profile(s,c),rep=salesRep(c),scoped=salesScoped(s,c),m=await s.listMasterData(c.company.id),data=await s.listEnterpriseData(c.company.id);
  const customers=m.customers.filter(x=>!scoped||(setting(s,'customer',x.id).channel||'retail')===p.channel).map(x=>({...x,...setting(s,'customer',x.id)}));
  const ids=new Set(customers.map(x=>x.id));
  const documents=(await s.listCommerceDocuments(c.company.id)).filter(x=>!scoped||(x.documentType.startsWith('sale')&&ids.has(x.customerId)&&(!p.salesManager||!x.assignedSalesManagerId||x.assignedSalesManagerId===c.user.id)));
 const prices=m.prices.filter(x=>!scoped||['sale_'+p.channel,'sale'].includes(x.priceType));
  const reservations=(s.salesSettings.get('reservations:'+c.company.id)?.rows||[]).filter(x=>x.status==='active'&&Date.parse(x.expiresAt)>Date.now());
  res.json({personalCards:setting(s,'board',c.user.id).cards||[],userProfiles:!c.permissions.includes('users.manage')?{}:Object.fromEntries([...s.salesSettings].filter(([k,v])=>k.startsWith('user:')&&v.companyId===c.company.id)),profile:p,representative:rep,salesManager:!!p.salesManager,customers,categories:m.categories||[],items:m.items.map(x=>{const {photos=[],...cfg}=setting(s,'item',x.id);return {...x,...cfg,hasPhotos:photos.length>0};}),units:m.units,prices,warehouses:m.warehouses.map(x=>({...x,...setting(s,'warehouse',x.id)})),stock:m.stock.map(({averageCost,...x})=>x),reservations,documents:documents.map(x=>({...x,lines:x.lines.map(({unitCost,...line})=>line)})),settlements:(data.settlements||[]).filter(x=>documents.some(d=>d.id===x.documentId)),approvals:[...s.salesApprovals.values()].filter(x=>x.companyId===c.company.id&&(rep?x.userId===c.user.id:p.salesManager?(x.managerUserId===c.user.id||(!x.managerUserId&&x.profile?.channel===p.channel)):true)),reviews:[...s.salesReviews.values()].filter(x=>x.companyId===c.company.id&&(rep?x.userId===c.user.id:p.salesManager?ids.has(x.customerId):true))});
 }));
 app.post('/api/v1/sales/reservations',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{if(!salesRep(req.auth))throw new AppError(400,'REP_REQUIRED','الحجز المؤقت خاص بالمندوب');const document=validateDocument(req.body.document),customer=known(s.customers,req.auth,document.partyId),minutes=Number(req.body.minutes);if(!Number.isInteger(minutes)||minutes<5||minutes>1440)throw new AppError(400,'INVALID_DURATION','مدة الحجز من ٥ دقائق إلى ٢٤ ساعة');const key='reservations:'+req.auth.company.id,now=Date.now(),current=s.salesSettings.get(key)?.rows||[],active=current.filter(x=>x.status==='active'&&Date.parse(x.expiresAt)>now);for(const line of document.lines){const warehouseId=line.warehouseId||document.warehouseId,relation=[...s.itemUnits.values()].find(x=>x.companyId===req.auth.company.id&&x.itemId===line.itemId&&x.unitId===line.unitId),stock=s.stockBalances.get(req.auth.company.id+':'+warehouseId+':'+line.itemId);if(!relation)fail('ITEM_UNIT_NOT_FOUND','وحدة المادة غير موجودة');const needed=multiply(decimal(line.quantity,{positive:true}),decimal(relation.conversionFactor)),held=active.flatMap(x=>x.lines).filter(x=>x.warehouseId===warehouseId&&x.itemId===line.itemId).reduce((n,x)=>n+decimal(x.baseQuantity),ZERO);if(decimal(stock?.quantity||'0')-held<needed)fail('RESERVATION_STOCK','الكمية المتاحة لا تكفي للحجز');line.warehouseId=warehouseId;line.baseQuantity=decimalString(needed);}const row={id:randomUUID(),companyId:req.auth.company.id,userId:req.auth.user.id,userName:req.auth.user.displayName,customerId:customer.id,customerName:customer.name,documentNumber:document.documentNumber,lines:document.lines,status:'active',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+minutes*60000).toISOString()};await s.saveSalesSetting(key,{companyId:req.auth.company.id,rows:[...active,row]},req.auth.user.id);res.status(201).json({reservation:row});}));
 app.delete('/api/v1/sales/reservations/:id',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{const key='reservations:'+req.auth.company.id,rows=s.salesSettings.get(key)?.rows||[],row=rows.find(x=>x.id===req.params.id);if(!row)throw new AppError(404,'NOT_FOUND','الحجز غير موجود');if(row.userId!==req.auth.user.id&&!req.auth.permissions.includes('company.manage')&&!profile(s,req.auth).salesManager)throw new AppError(403,'FORBIDDEN','لا يمكنك إلغاء هذا الحجز');row.status='cancelled';row.cancelledAt=new Date().toISOString();await s.saveSalesSetting(key,{companyId:req.auth.company.id,rows},req.auth.user.id);res.json({reservation:row});}));
 app.put('/api/v1/sales/personal-board',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const rows=req.body.cards;if(!Array.isArray(rows)||rows.length>100)throw new AppError(400,'INVALID_BOARD','الحد الأقصى ١٠٠ بطاقة');
  const ids=new Set();const cards=rows.map(x=>{if(typeof x.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(x.id)||ids.has(x.id)||!['note','reminder'].includes(x.kind)||typeof x.text!=='string'||!x.text.trim()||x.text.length>2000)throw new AppError(400,'INVALID_CARD','بطاقة غير صالحة');ids.add(x.id);let dueAt=null;if(x.kind==='reminder'){if(!x.dueAt||!Number.isFinite(Date.parse(x.dueAt)))throw new AppError(400,'INVALID_REMINDER','حدد موعد التذكير');dueAt=new Date(x.dueAt).toISOString();}return {id:x.id,kind:x.kind,text:x.text.trim(),dueAt,done:x.done===true};});
  await s.saveSalesSetting('board:'+req.auth.user.id,{companyId:req.auth.company.id,cards},req.auth.user.id);res.json({cards});
 }));
 for(const [type,map,permission] of [['user','users','users.manage'],['customer','customers','customers.manage'],['item','items','catalog.manage'],['warehouse','warehouses','inventory.manage']]){
  app.put('/api/v1/sales/settings/'+type+'/:id',auth,permit(permission),supported,asyncRoute(async(req,res)=>{
   known(s[map],req.auth,req.params.id);const b=req.body,cfg={...structuredClone(setting(s,type,req.params.id)),companyId:req.auth.company.id};
   if(['user','customer'].includes(type)){if(!['retail','wholesale'].includes(b.channel))throw new AppError(400,'INVALID_CHANNEL','حدد مفرد أو جملة');cfg.channel=b.channel;}
   if(type==='user'){cfg.salesManager=b.salesManager===true;cfg.managerUserId=b.managerUserId||null;if(cfg.managerUserId){known(s.users,req.auth,cfg.managerUserId);const manager=setting(s,'user',cfg.managerUserId);if(!manager.salesManager||manager.channel!==cfg.channel)throw new AppError(400,'INVALID_SALES_MANAGER','اختر مدير المبيعات من نفس النوع');}cfg.phone=String(b.phone||'').slice(0,40);cfg.location=String(b.location||'').slice(0,200);cfg.maxDiscountPercent=decimalString(decimal(b.maxDiscountPercent||'0',{nonNegative:true}));if(decimal(cfg.maxDiscountPercent)>decimal('100'))throw new AppError(400,'INVALID_DISCOUNT','الخصم لا يتجاوز ١٠٠٪');}
   if(type==='customer'){for(const k of ['governorate','district','neighborhood'])cfg[k]=String(b[k]||'').slice(0,120);if(!['green','yellow','red'].includes(b.risk))throw new AppError(400,'INVALID_RISK','التصنيف غير صالح');cfg.risk=b.risk;}
   if(type==='item'){cfg.photos=setting(s,'item',req.params.id).photos||[];if(!['both','retail','wholesale'].includes(b.channel)||!['slow','moving','strong'].includes(b.movement))throw new AppError(400,'INVALID_ITEM_POLICY','تصنيف المادة غير صالح');cfg.channel=b.channel;cfg.movement=b.movement;cfg.maxDiscountPercent=decimalString(decimal(b.maxDiscountPercent||'0',{nonNegative:true}));if(decimal(cfg.maxDiscountPercent)>decimal('100'))throw new AppError(400,'INVALID_DISCOUNT','الخصم لا يتجاوز ١٠٠٪');cfg.reserved={...(setting(s,type,req.params.id).reserved||{})};if(b.warehouseId){known(s.warehouses,req.auth,b.warehouseId);cfg.reserved[b.warehouseId]=decimalString(decimal(b.reservedQuantity||'0',{nonNegative:true}));}}
   if(type==='warehouse'){cfg.damaged=b.damaged===true;cfg.placeType=['warehouse','showroom','branch','vehicle'].includes(b.placeType)?b.placeType:'warehouse';}
   await s.saveSalesSetting(type+':'+req.params.id,cfg,req.auth.user.id);res.json({setting:cfg});
  }));
 }
 const photosDir=()=>{if(!s.filename)throw new AppError(501,'SQLITE_REQUIRED','حفظ الصور يحتاج قرص SQLite');return join(dirname(s.filename),'item-photos');};
 app.get('/api/v1/sales/items/:id/photos',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{known(s.items,req.auth,req.params.id);res.set('Cache-Control','private, no-store');res.json({photos:(setting(s,'item',req.params.id).photos||[]).map(p=>({id:p.id,url:'/api/v1/sales/items/'+req.params.id+'/photos/'+p.id}))});}));
 app.get('/api/v1/sales/items/:id/photos/:photoId',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{known(s.items,req.auth,req.params.id);const photo=(setting(s,'item',req.params.id).photos||[]).find(p=>p.id===req.params.photoId);if(!photo)throw new AppError(404,'NOT_FOUND','الصورة غير موجودة');res.set('Cache-Control','private, no-store');res.type(photo.mime).sendFile(join(photosDir(),photo.filename));}));
 app.post('/api/v1/sales/items/:id/photos',auth,permit('catalog.manage'),supported,asyncRoute(async(req,res)=>{
  known(s.items,req.auth,req.params.id);const cfg=setting(s,'item',req.params.id),photos=cfg.photos||[];if(photos.length>=6)throw new AppError(400,'PHOTO_LIMIT','الحد الأقصى ٦ صور لكل مادة');
  const match=typeof req.body.image==='string'&&/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(req.body.image);if(!match)throw new AppError(400,'INVALID_PHOTO','ارفع صورة JPEG أو PNG أو WebP');const bytes=Buffer.from(match[2],'base64');const valid=match[1]==='jpeg'?bytes.subarray(0,3).equals(Buffer.from([255,216,255])):match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!valid||bytes.length>750000||!bytes.length)throw new AppError(400,'INVALID_PHOTO','الصورة غير صالحة أو أكبر من الحجم المسموح');
  const id=randomUUID(),filename=id+'.'+(match[1]==='jpeg'?'jpg':match[1]),dir=photosDir();await mkdir(dir,{recursive:true});await writeFile(join(dir,filename),bytes,{flag:'wx'});try{await s.saveSalesSetting('item:'+req.params.id,{...cfg,companyId:req.auth.company.id,photos:[...photos,{id,filename,mime:'image/'+match[1]}]},req.auth.user.id);}catch(error){await unlink(join(dir,filename));throw error;}res.status(201).json({photo:{id}});
 }));
 app.post('/api/v1/sales/walk-in',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const b=req.body,name=String(b.name||'').trim();if(!name||name.length>120)throw new AppError(400,'NAME_REQUIRED','اسم الزبون مطلوب');const customer=await s.createParty(req.auth.company.id,'customer',{code:'WALK-'+randomUUID(),name,phone:String(b.phone||'').slice(0,40),creditLimit:'0'},req.auth.user.id);const cfg={companyId:req.auth.company.id,channel:salesRep(req.auth)?profile(s,req.auth).channel:(b.channel==='wholesale'?'wholesale':'retail'),neighborhood:String(b.address||'').slice(0,120),risk:'green',oneTime:true};await s.saveSalesSetting('customer:'+customer.id,cfg,req.auth.user.id);res.status(201).json({customer:{...customer,...cfg}});
 }));
 app.post('/api/v1/sales/approvals',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  if(!salesRep(req.auth))throw new AppError(400,'REP_REQUIRED','إرسال الفاتورة خاص بالمندوب');const document=validateDocument(req.body.document),reasons=salesReasons(s,req.auth,document),internalNote=String(req.body.internalNote||'').trim();if(internalNote.length>1600)throw new AppError(400,'NOTE_TOO_LONG','ملاحظة المدير طويلة جدًا');
  const row={id:randomUUID(),companyId:req.auth.company.id,userId:req.auth.user.id,userName:req.auth.user.displayName,profile:profile(s,req.auth),managerUserId:assignedSalesManager(s,req.auth),document:{...document,approvalId:null},fingerprint:fp(document),reasons:reasons.length?reasons:['اعتماد مبلغ الفاتورة'],internalNote,status:'pending',createdAt:new Date().toISOString()};await s.saveSalesApproval(row);res.status(201).json({approval:row});
 }));
 app.post('/api/v1/sales/approvals/:id/decision',auth,(req,res,next)=>{if(req.auth.permissions.includes('company.manage')||(profile(s,req.auth).salesManager&&req.auth.permissions.includes('sales.approve')))return next();next(new AppError(403,'FORBIDDEN','تحتاج صلاحية مدير المبيعات'));},supported,asyncRoute(async(req,res)=>{
  const old=known(s.salesApprovals,req.auth,req.params.id);const p=profile(s,req.auth);if(p.salesManager&&(old.profile.channel!==p.channel||(old.managerUserId&&old.managerUserId!==req.auth.user.id)))throw new AppError(403,'MANAGER_SCOPE','الطلب موجّه لمدير مبيعات آخر');if(old.status!=='pending')fail('ALREADY_DECIDED','تمت مراجعة الطلب');if(!['approved','rejected'].includes(req.body.status))throw new AppError(400,'INVALID_DECISION','قرار غير صالح');const row={...old,status:req.body.status,reviewedBy:req.auth.user.id,reviewedAt:new Date().toISOString()};await s.saveSalesApproval(row);res.json({approval:row});
 }));
 app.post('/api/v1/sales/customer-review',auth,permit('sales.create'),supported,asyncRoute(async(req,res)=>{
  const customer=known(s.customers,req.auth,req.body.customerId);if(salesRep(req.auth)&&(setting(s,'customer',customer.id).channel||'retail')!==profile(s,req.auth).channel)throw new AppError(403,'CUSTOMER_SCOPE','الزبون خارج صلاحيتك');const row={id:randomUUID(),companyId:req.auth.company.id,userId:req.auth.user.id,userName:req.auth.user.displayName,customerId:customer.id,customerName:customer.name,createdAt:new Date().toISOString()};await s.saveSalesReview(row);res.status(201).json({review:row});
 }));
}

