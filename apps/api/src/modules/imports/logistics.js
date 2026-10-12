import {randomUUID,createHash} from 'node:crypto';
import {AppError,asyncRoute,requireFields} from '../../lib/http.js';
import {decimal,decimalString,ZERO} from '../../lib/decimal.js';

const fail=(code,message,status=400)=>{throw new AppError(status,code,message);};
const text=(value,max=300)=>String(value??'').trim().slice(0,max);
const date=value=>{if(!value)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)||!Number.isFinite(Date.parse(value)))fail('INVALID_DATE','التاريخ غير صالح');return new Date(value).toISOString();};
const enumValue=(value,choices,fallback)=>{const normalized=text(value)||fallback;if(!choices.includes(normalized))fail('INVALID_LOGISTICS_VALUE','اختر قيمة صالحة');return normalized;};
export const LOGISTICS_STAGES=['supplier','origin_port','sea_transit','destination_port','customs','road_transit','delivered','closed'];
export const CHARGE_CODES=['freight','road','customs','clearance','insurance','handling','demurrage','storage','other'];
const partner=(store,auth,id,uuid,allowInactive=false)=>{if(!id)return null;const row=store.logisticsRecords.get(uuid(id,'partnerId'));if(!row||row.kind!=='partner'||row.companyId!==auth.company.id||row.active===false&&!allowInactive)fail('LOGISTICS_PARTNER_INVALID','الناقل أو المخلص غير موجود أو موقوف');return row.id;};
export function normalizeLogistics(value,{store,auth,uuid,decimalInput,previous={}}) {
  if(!value||Array.isArray(value)||typeof value!=='object')fail('INVALID_LOGISTICS','بيانات ملف الشحنة غير صالحة');
  const result={mode:enumValue(value.mode,['sea','road','multimodal'],'sea')};
  for(const key of ['factory','pickupAddress','originPort','destinationPort','finalDestination','consignee','cargoDescription','hsCode','incoterm','bookingNumber','vessel','voyage','shippingAgent','containerType','containerSize','sealNumber','vehiclePlate','vehicleType','driverName','driverPhone','driverPhone2','route','insuranceCompany','insurancePolicy','insuranceCoverage','clearanceDeclaration','customsOffice','notes'])result[key]=text(value[key],key==='notes'||key==='cargoDescription'||key==='route'?2000:300);
  for(const [key,role] of [['seaCarrierId','sea_carrier'],['roadCarrierId','road_carrier'],['brokerId','broker']]){
    result[key]=partner(store,auth,value[key],uuid,value[key]===previous[key]);
    const row=result[key]&&store.logisticsRecords.get(result[key]);
    if(row&&row.role!==role)fail('INVALID_PARTNER_ROLE','نوع الجهة لا يطابق حقل الشحنة');
    if(row&&(auth.scopes||[]).some(x=>['branch','warehouse'].includes(x.type))&&row.createdBy!==auth.user.id){
      const visible=[...store.importShipments.values()].some(sh=>{
        if(sh.companyId!==auth.company.id||![sh.logistics?.seaCarrierId,sh.logistics?.roadCarrierId,sh.logistics?.brokerId].includes(row.id))return false;
        if(!sh.purchaseDocumentId)return sh.createdBy===auth.user.id;
        const doc=store.commerceDocuments.get(sh.purchaseDocumentId),wh=store.warehouses.get(doc?.warehouseId);
        return (auth.scopes||[]).filter(x=>['branch','warehouse'].includes(x.type)).every(x=>x.id===(x.type==='branch'?wh?.branchId:wh?.id));
      });
      if(!visible)fail('LOGISTICS_PARTNER_SCOPE','الجهة خارج نطاق حسابك',403);
    }
  }
  for(const key of ['pickupAt','portArrivalAt','clearanceAt','deliveredAt','freeUntil','containerReturnedAt','insuranceExpiresAt'])result[key]=date(value[key]);
  for(const key of ['grossWeight','volume','insuredAmount','dailyDemurrage'])result[key]=decimalInput(value[key]||'0',{nonNegative:true});
  for(const key of ['packages','containerCount','wheelCount']){const n=Number(value[key]||0);if(!Number.isSafeInteger(n)||n<0||n>1000000)fail('INVALID_LOGISTICS_COUNT','عدد العبوات أو الحاويات أو العجلات غير صالح');result[key]=n;}
  if(result.insuranceExpiresAt&&result.pickupAt&&result.insuranceExpiresAt<result.pickupAt)fail('INVALID_INSURANCE_DATES','انتهاء التأمين يسبق استلام الشحنة');
  if(result.deliveredAt&&result.pickupAt&&result.deliveredAt<result.pickupAt)fail('INVALID_DELIVERY_DATES','التسليم يسبق استلام البضاعة');
  return result;
}

export function installLogisticsRoutes(app,{store,authenticate,permit,uuid,decimalInput,currency,assertShipmentScope}) {
  let queue=Promise.resolve();
  const mutate=callback=>{
    if(typeof store.transaction==='function')return store.transaction(callback);
    const task=queue.then(async()=>{const before=Object.entries(store).filter(([,v])=>v instanceof Map||Array.isArray(v)||typeof v==='number').map(([k,v])=>[k,structuredClone(v)]);try{return await callback();}catch(error){for(const [k,v] of before)store[k]=v;throw error;}});queue=task.catch(()=>{});return task;
  };
  const getShipment=(req,id)=>{const row=store.importShipments.get(uuid(id,'shipmentId'));assertShipmentScope(req,row);return row;};
  const visibleShipments=req=>[...store.importShipments.values()].filter(row=>{try{assertShipmentScope(req,row);return true;}catch{return false;}});
  const visiblePartners=(req,shipments)=>{const scoped=(req.auth.scopes||[]).some(x=>['branch','warehouse'].includes(x.type));const ids=new Set(shipments.flatMap(x=>[x.logistics?.seaCarrierId,x.logistics?.roadCarrierId,x.logistics?.brokerId]));return [...store.logisticsRecords.values()].filter(x=>x.companyId===req.auth.company.id&&x.kind==='partner'&&(!scoped||x.createdBy===req.auth.user.id||ids.has(x.id)));};
  const getPartner=(req,id)=>{const row=visiblePartners(req,visibleShipments(req)).find(x=>x.id===id);if(!row)fail('LOGISTICS_PARTNER_NOT_FOUND','الجهة خارج نطاق حسابك',403);return row;};
  const save=(req,row)=>store.saveLogisticsRecord(req.auth,row);
  async function operation(req,kind,callback){
    requireFields(req.body,['operationId']);const opId=uuid(req.body.operationId,'operationId');const fingerprint=createHash('sha256').update(JSON.stringify({kind,params:req.params,body:req.body})).digest('hex');
    return mutate(async()=>{const key=req.auth.company.id+':logistics:'+opId,previous=store.logisticsRecords.get(key);if(previous){if(previous.fingerprint!==fingerprint||previous.userId!==req.auth.user.id)fail('OPERATION_ID_REUSED','معرف العملية مستخدم لبيانات أخرى',409);return structuredClone(previous.result);}const result=await callback();await save(req,{id:key,kind:'operation',fingerprint,userId:req.auth.user.id,result});return result;});
  }
  const read=(req,res,next)=>req.auth.permissions.some(p=>['imports.read','imports.manage'].includes(p))?next():next(new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية للشحن والنقل'));
  const financial=req=>{if(!req.auth.permissions.includes('accounting.post'))fail('PERMISSION_DENIED','تحتاج صلاحية ترحيل محاسبي',403);if((req.auth.scopes||[]).some(s=>s.type==='warehouse'))fail('COMPANY_SCOPE_REQUIRED','الترحيل يحتاج نطاق الشركة أو الفرع',403);};
  const branchOf=(req,shipment)=>{const doc=store.commerceDocuments.get(shipment.purchaseDocumentId);return doc?.branchId||store.warehouses.get(doc?.warehouseId)?.branchId||((req.auth.scopes||[]).filter(s=>s.type==='branch').length===1?req.auth.scopes.find(s=>s.type==='branch').id:null);};
  const chargeRows=(req,shipmentId)=>[...store.logisticsRecords.values()].filter(x=>x.companyId===req.auth.company.id&&x.kind==='charge'&&x.shipmentId===shipmentId);
  app.get('/api/v1/import/logistics',authenticate(store),read,asyncRoute(async(req,res)=>{
    const shipments=visibleShipments(req),ids=new Set(shipments.map(x=>x.id)),partners=visiblePartners(req,shipments);
    const records=[...store.logisticsRecords.values()].filter(x=>x.companyId===req.auth.company.id&&x.kind!=='operation'&&x.kind!=='partner'&&ids.has(x.shipmentId)).map(x=>structuredClone(x));
    // Reversed payment/expense vouchers must no longer reduce operational balances.
    for(const row of records)if(row.journalEntryId||row.costPostingId){const journal=store.journalEntries.get(row.journalEntryId||store.importCostPostings.get(row.costPostingId)?.journalEntryId);row.journalStatus=journal?.reversedByJournalId?'reversed':journal?.status||'missing';}
    res.set('Cache-Control','no-store').json({partners,records,stages:LOGISTICS_STAGES});
  }));
  app.post('/api/v1/import/partners',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const result=await operation(req,'partner',async()=>{
      requireFields(req.body,['code','name','role']);const code=text(req.body.code,80),name=text(req.body.name,200),role=enumValue(req.body.role,['sea_carrier','road_carrier','broker','agent','insurer']);
      const id=req.body.id?uuid(req.body.id,'id'):randomUUID(),previous=req.body.id?getPartner(req,id):null;
      if(previous&&previous.role!==role&&[...store.importShipments.values()].some(sh=>sh.companyId===req.auth.company.id&&[sh.logistics?.seaCarrierId,sh.logistics?.roadCarrierId,sh.logistics?.brokerId].includes(previous.id)))fail('PARTNER_ROLE_IN_USE','الجهة مرتبطة بشحنات؛ لا تغير نوعها',409);
      if(previous&&(req.body.revision!==previous.revision))fail('PARTNER_CHANGED','تم تعديل الجهة؛ أعد فتحها',409);
      if([...store.logisticsRecords.values()].some(x=>x.kind==='partner'&&x.companyId===req.auth.company.id&&x.code===code&&x.id!==id))fail('PARTNER_CODE_EXISTS','رمز الجهة مستخدم',409);
      const email=text(req.body.email,254);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('INVALID_EMAIL','عنوان البريد غير صالح');
      const accountCode=text(req.body.accountCode,80);if(accountCode&&!store.listChartAccounts(req.auth.company.id).some(a=>a.code===accountCode&&a.type==='liability'&&a.active!==false))fail('INVALID_PARTNER_ACCOUNT','اختر حساب التزام فعالًا من دليل الحسابات');
      return {partner:await save(req,{id,kind:'partner',code,name,role,phone:text(req.body.phone,80),phone2:text(req.body.phone2,80),email,address:text(req.body.address,600),contactName:text(req.body.contactName,200),taxNumber:text(req.body.taxNumber,100),accountCode,notes:text(req.body.notes,2000),active:req.body.active!==false,revision:(previous?.revision||0)+1,createdAt:previous?.createdAt||new Date().toISOString(),createdBy:previous?.createdBy||req.auth.user.id})};
    });res.status(201).json(result);
  }));
  app.patch('/api/v1/import/shipments/:shipmentId/logistics',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);const result=await operation(req,'profile',async()=>{const logistics=normalizeLogistics(req.body.logistics,{store,auth:req.auth,uuid,decimalInput,previous:shipment.logistics||{}});for(const key of ['seaCarrierId','roadCarrierId','brokerId'])if(logistics[key])getPartner(req,logistics[key]);const details={};if(req.body.details){for(const k of ['containerNumber','billOfLading','origin'])details[k]=text(req.body.details[k],120);for(const k of ['shippedAt','expectedAt'])details[k]=date(req.body.details[k]);if(details.shippedAt&&details.expectedAt&&details.expectedAt<details.shippedAt)fail('INVALID_SHIPMENT_DATES','الوصول المتوقع يسبق المغادرة');}return{shipment:await store.updateImportLogistics(req.auth,shipment.id,logistics,req.body.revision,details)};});res.json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/events',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);const result=await operation(req,'event',async()=>{
      const stage=enumValue(req.body.stage,LOGISTICS_STAGES),occurredAt=date(req.body.occurredAt);if(!occurredAt)fail('EVENT_DATE_REQUIRED','وقت المتابعة مطلوب');
      const events=[...store.logisticsRecords.values()].filter(x=>x.kind==='event'&&x.shipmentId===shipment.id).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
      const last=events.at(-1);if(last&&occurredAt<last.occurredAt)fail('EVENT_DATE_ORDER','وقت المرحلة يسبق آخر تحديث');if(last&&LOGISTICS_STAGES.indexOf(stage)<LOGISTICS_STAGES.indexOf(last.stage))fail('EVENT_STAGE_ORDER','لا يمكن الرجوع لمرحلة سابقة؛ أضف ملاحظة على المرحلة الحالية');
      return{event:await save(req,{id:randomUUID(),kind:'event',shipmentId:shipment.id,stage,occurredAt,location:text(req.body.location),reference:text(req.body.reference,160),note:text(req.body.note,2000),createdBy:req.auth.user.id})};
    });res.status(201).json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/charges',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);const result=await operation(req,'charge',async()=>{
      const partnerId=partner(store,req.auth,req.body.partnerId,uuid);if(!partnerId)fail('PARTNER_REQUIRED','حدد الجهة المستحقة');getPartner(req,partnerId);
      const code=enumValue(req.body.code,CHARGE_CODES),status=enumValue(req.body.status,['estimated','final'],'estimated'),amount=decimalInput(req.body.amount,{positive:true});
      const description=text(req.body.description,300);if(!description)fail('DESCRIPTION_REQUIRED','بيان الأجر مطلوب');
      return{charge:await save(req,{id:randomUUID(),kind:'charge',shipmentId:shipment.id,partnerId,code,status,amount,currency:currency(req.body.currency),description,invoiceNumber:text(req.body.invoiceNumber,160),dueAt:date(req.body.dueAt),occurredAt:date(req.body.occurredAt)||new Date().toISOString(),createdBy:req.auth.user.id,revision:1})};
    });res.status(201).json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/charges/:chargeId/finalize',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);const result=await operation(req,'finalize',async()=>{
      const charge=chargeRows(req,shipment.id).find(x=>x.id===uuid(req.params.chargeId,'chargeId'));if(!charge||charge.status!=='estimated')fail('CHARGE_NOT_ESTIMATED','البند ليس تقديريًا');
      return{charge:await save(req,{...charge,amount:decimalInput(req.body.amount,{positive:true}),status:'final',revision:charge.revision+1})};
    });res.json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/charges/:chargeId/cancel',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);const result=await operation(req,'cancel-charge',async()=>{
      const charge=chargeRows(req,shipment.id).find(x=>x.id===uuid(req.params.chargeId,'chargeId'));
      if(!charge||charge.status==='cancelled'||charge.journalEntryId||charge.costPostingId)fail('CHARGE_NOT_CANCELLABLE','يمكن إلغاء الأجور غير المرحلة فقط');
      const reason=text(req.body.reason,1000);if(!reason)fail('CANCELLATION_REASON_REQUIRED','سبب إلغاء الأجر مطلوب');
      return{charge:await save(req,{...charge,status:'cancelled',cancellationReason:reason,revision:charge.revision+1})};
    });res.json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/charges/:chargeId/post',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);financial(req);const result=await operation(req,'post-charge',async()=>{
      const charge=chargeRows(req,shipment.id).find(x=>x.id===uuid(req.params.chargeId,'chargeId'));if(!charge||charge.status!=='final'||charge.journalEntryId||charge.costPostingId)fail('CHARGE_NOT_POSTABLE','يلزم أجر نهائي غير مرحّل');
      const p=getPartner(req,charge.partnerId),accountCode=p.accountCode||'2100-AP',expenseCode=text(req.body.expenseCode,80);
      if(!store.listChartAccounts(req.auth.company.id).some(a=>a.code===expenseCode&&a.type==='expense'&&a.active!==false))fail('INVALID_EXPENSE_ACCOUNT','اختر حساب مصروف فعالًا');
      const journal=await store.postLogisticsJournal(req.auth,{operationId:req.body.operationId,entryNumber:'SHP-EXP-'+charge.id,currency:charge.currency,occurredAt:date(req.body.occurredAt)||new Date().toISOString(),description:shipment.shipmentNumber+' / '+p.name+' / '+charge.description,branchId:branchOf(req,shipment),lines:[{accountCode:expenseCode,debit:charge.amount,credit:'0'},{accountCode,debit:'0',credit:charge.amount}]});
      return{charge:await save(req,{...charge,journalEntryId:journal.id,payableAccountCode:accountCode}),journal};
    });res.status(201).json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/payments',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);financial(req);const result=await operation(req,'payment',async()=>{
      const charge=chargeRows(req,shipment.id).find(x=>x.id===uuid(req.body.chargeId,'chargeId'));
      const liabilityJournal=store.journalEntries.get(charge?.journalEntryId||store.importCostPostings.get(charge?.costPostingId)?.journalEntryId);
      if(!charge||charge.status!=='final'||(liabilityJournal?.status!=='posted'||liabilityJournal.reversedByJournalId))fail('CHARGE_NOT_POSTED','رحّل الأجر إلى المصروفات أو كلفة المخزون قبل السداد');
      const amount=decimalInput(req.body.amount,{positive:true}),paid=[...store.logisticsRecords.values()].filter(x=>x.kind==='payment'&&x.companyId===req.auth.company.id&&x.chargeId===charge.id&&store.journalEntries.get(x.journalEntryId)?.status==='posted'&&!store.journalEntries.get(x.journalEntryId)?.reversedByJournalId).reduce((sum,x)=>sum+decimal(x.amount),ZERO);
      if(paid+decimal(amount)>decimal(charge.amount))fail('PAYMENT_EXCEEDS_DUE','السداد يتجاوز المبلغ المستحق');
      const cashboxId=req.body.cashboxId?uuid(req.body.cashboxId,'cashboxId'):null,box=cashboxId&&store.cashboxes.get(cashboxId);
      if(cashboxId&&(!box||box.companyId!==req.auth.company.id||box.active===false))fail('CASHBOX_NOT_FOUND','الصندوق غير موجود أو موقوف');
      const cashAccountCode=box?.accountCode||text(req.body.cashAccountCode,80),account=store.listChartAccounts(req.auth.company.id).find(a=>a.code===cashAccountCode&&a.type==='asset'&&a.active!==false);
      if(!account||!(/CASH|BANK/.test(account.code)))fail('INVALID_PAYMENT_ACCOUNT','اختر حساب صندوق أو بنك فعالًا');
      if((cashAccountCode==='1000-CASH'||cashAccountCode==='1010-BANK')&&charge.currency!=='IQD'||cashAccountCode.endsWith('-USD')&&charge.currency!=='USD'||box&&box.currency!==charge.currency)fail('PAYMENT_CURRENCY_MISMATCH','عملة حساب الدفع لا تطابق عملة الأجر');
      if(!box&&[...store.cashboxes.values()].some(b=>b.companyId===req.auth.company.id&&b.accountCode===cashAccountCode))fail('CASHBOX_REQUIRED','حدد الصندوق الفعلي لتسجيل حركة الشفت');
      if(box?.branchId&&box.branchId!==branchOf(req,shipment))fail('CASHBOX_BRANCH_DENIED','الصندوق خارج فرع الشحنة',403);
      const receiptNumber=text(req.body.receiptNumber,120);if(!receiptNumber)fail('RECEIPT_REQUIRED','رقم سند الدفع مطلوب');
      if([...store.logisticsRecords.values()].some(x=>x.kind==='payment'&&x.companyId===req.auth.company.id&&x.receiptNumber===receiptNumber))fail('RECEIPT_EXISTS','رقم سند الدفع مستخدم',409);
      const p=getPartner(req,charge.partnerId),occurredAt=date(req.body.occurredAt)||new Date().toISOString();
      let journal;
      if(box){const movement=await store.postCashboxMovement(req.auth,box.id,{operationId:req.body.operationId,movementNumber:receiptNumber,amount,direction:'out',counterAccountCode:charge.payableAccountCode||'2100-AP',occurredAt,reference:text(req.body.reference,160),note:shipment.shipmentNumber+' / '+p.name});journal=await store.postLogisticsJournal(req.auth,{...store.journalEntries.get(movement.journalEntryId),description:shipment.shipmentNumber+' / سداد '+p.name});}
      else journal=await store.postLogisticsJournal(req.auth,{operationId:req.body.operationId,entryNumber:'SHP-PAY-'+receiptNumber,currency:charge.currency,occurredAt,description:shipment.shipmentNumber+' / سداد '+p.name,branchId:branchOf(req,shipment),lines:[{accountCode:charge.payableAccountCode||'2100-AP',debit:amount,credit:'0'},{accountCode:cashAccountCode,debit:'0',credit:amount}]});
      return{payment:await save(req,{id:randomUUID(),kind:'payment',shipmentId:shipment.id,chargeId:charge.id,partnerId:charge.partnerId,amount,currency:charge.currency,receiptNumber,cashboxId:box?.id||null,occurredAt,reference:text(req.body.reference,160),journalEntryId:journal.id,createdBy:req.auth.user.id}),journal};
    });res.status(201).json(result);
  }));
  app.post('/api/v1/import/shipments/:shipmentId/correspondence',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);const result=await operation(req,'correspondence',async()=>{
      const partnerId=partner(store,req.auth,req.body.partnerId,uuid);if(partnerId)getPartner(req,partnerId);
      const subject=text(req.body.subject,300),body=text(req.body.body,12000);if(!subject||!body)fail('CORRESPONDENCE_REQUIRED','موضوع المراسلة ونصها مطلوبان');
      const attachmentUrl=text(req.body.attachmentUrl,2000);if(attachmentUrl){try{const url=new URL(attachmentUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error();}catch{fail('INVALID_ATTACHMENT_URL','رابط المستند يجب أن يبدأ بـ https');}}
      const email=text(req.body.email,254);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('INVALID_EMAIL','عنوان البريد غير صالح');
      return{correspondence:await save(req,{id:randomUUID(),kind:'correspondence',shipmentId:shipment.id,partnerId,channel:enumValue(req.body.channel,['email','phone','whatsapp','document','note'],'email'),direction:enumValue(req.body.direction,['incoming','outgoing','draft'],'draft'),subject,body,email,attachmentUrl,reference:text(req.body.reference,160),occurredAt:date(req.body.occurredAt)||new Date().toISOString(),createdBy:req.auth.user.id})};
    });res.status(201).json(result);
  }));
  // Landed costs use selected final charges once. The original endpoint remains
  // compatible with older clients; this path avoids JSON input and duplicate posting.
  app.post('/api/v1/import/shipments/:shipmentId/capitalize',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    const shipment=getShipment(req,req.params.shipmentId);financial(req);const result=await operation(req,'capitalize',async()=>{
      if(!Array.isArray(req.body.chargeIds)||!req.body.chargeIds.length||new Set(req.body.chargeIds).size!==req.body.chargeIds.length)fail('INVALID_CHARGES','حدد الأجور النهائية المراد رسملتها');
      const charges=req.body.chargeIds.map(id=>chargeRows(req,shipment.id).find(x=>x.id===uuid(id,'chargeId')));
      if(charges.some(x=>!x||x.status!=='final'||x.currency!==req.auth.company.currency||x.journalEntryId||x.costPostingId))fail('INVALID_CAPITALIZATION','حدد أجورًا نهائية غير مرحلة بعملة الشركة');
      const purchase=store.commerceDocuments.get(shipment.purchaseDocumentId);if(!purchase)fail('PURCHASE_REQUIRED','أثبت الوصول واربط فاتورة الشراء أولًا');
      const total=charges.reduce((sum,x)=>sum+decimal(x.amount),ZERO),weights=new Map();for(const line of purchase.lines)weights.set(line.itemId,(weights.get(line.itemId)||ZERO)+decimal(line.lineTotal||'0'));
      const entries=[...weights],weight=entries.reduce((sum,[,v])=>sum+v,ZERO);if(weight<=ZERO)fail('INVALID_ALLOCATION','قيمة فاتورة الشراء لا تصلح للتوزيع');
      let assigned=ZERO;const allocations=entries.map(([itemId,w],i)=>{const amount=i===entries.length-1?total-assigned:total*w/weight;assigned+=amount;return{itemId,amount:decimalString(amount)};}).filter(x=>decimal(x.amount)>ZERO);
      const cost=await store.postImportCosts(req.auth,shipment.id,{operationId:req.body.operationId,currency:req.auth.company.currency,occurredAt:date(req.body.occurredAt)||new Date().toISOString(),charges:charges.map(x=>({code:['freight','customs','insurance','handling'].includes(x.code)?x.code:'other',description:x.description,amount:x.amount})),allocations});
      for(const charge of charges)await save(req,{...charge,costPostingId:cost.id,payableAccountCode:'2100-AP'});
      return{cost};
    });res.status(201).json(result);
  }));
}
