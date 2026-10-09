import {whatsappConfigured,verifyWhatsAppSignature,startNotificationWorker} from '../../lib/whatsapp-provider.js';
import {randomUUID} from 'node:crypto';
import {AppError,asyncRoute} from '../../lib/http.js';
import {whatsappPhone} from '../../lib/customer-notifications.js';

export function notificationContacts(store,companyId){
 const contacts=[];
 for(const [type,map] of Object.entries({customer:store.customers,employee:store.employees,representative:store.representatives,user:store.users})){
  for(const row of map.values())if(row.companyId===companyId){
   const profile=type==='user'?store.salesSettings.get('user:'+row.id):{};
   const linkedUser=row.userId?store.users.get(row.userId):null;
   contacts.push({type,id:row.id,name:row.name||row.fullName||row.displayName||linkedUser?.displayName||row.code||'',phone:row.phone||profile?.phone||(linkedUser?store.salesSettings.get('user:'+linkedUser.id)?.phone:'')||''});
  }
 }
 return contacts;
}

export function installNotificationRoutes(app,{store,authenticate,permit,sending=false}){
 if(sending&&store.transaction)app.stopNotifications=startNotificationWorker(store);
 app.get('/api/v1/notifications/webhook',(req,res)=>{if(process.env.WHATSAPP_VERIFY_TOKEN&&req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===process.env.WHATSAPP_VERIFY_TOKEN)return res.type('text').send(String(req.query['hub.challenge']||''));res.sendStatus(403);});
 app.post('/api/v1/notifications/webhook',asyncRoute(async(req,res)=>{
  if(!verifyWhatsAppSignature(req.rawBody,req.get('x-hub-signature-256'),process.env.WHATSAPP_APP_SECRET))return res.sendStatus(403);
  if(!store.transaction)return res.sendStatus(501);
  await store.transaction(()=>{for(const entry of req.body.entry||[])for(const change of entry.changes||[]){const value=change.value;if(value?.metadata?.phone_number_id!==process.env.WHATSAPP_PHONE_NUMBER_ID)continue;for(const status of value.statuses||[]){const message=store.customerNotifications.get(status.biz_opaque_callback_data)||[...store.customerNotifications.values()].find(x=>x.providerId===status.id);if(!message||message.companyId!==process.env.WHATSAPP_COMPANY_ID||!['sent','delivered','read','failed'].includes(status.status))continue;const rank={draft:0,queued:0,sending:0,uncertain:0,accepted:1,sent:2,delivered:3,read:4,failed:1};if((rank[message.status]||0)>(rank[status.status]||0))continue;store.customerNotifications.set(message.id,{...message,providerId:status.id,status:status.status,statusAt:new Date(Number(status.timestamp)*1000||Date.now()).toISOString(),error:status.status==='failed'?'رفضت الخدمة تسليم الرسالة (رمز '+(status.errors?.[0]?.code||'غير محدد')+')':null});}}});res.sendStatus(200);
 }));
 const authorized=[authenticate(store),permit('company.manage')];
 app.get('/api/v1/notifications',...authorized,(req,res)=>{
  const companyId=req.auth.company.id;
  res.json({contacts:notificationContacts(store,companyId),messages:[...store.customerNotifications.values()].filter(x=>x.companyId===companyId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,300),settings:store.salesSettings.get('notification-settings:'+companyId)||{mode:'manual',receiptDrafts:true},cloudConfigured:whatsappConfigured(companyId)});
 });
 app.put('/api/v1/notifications/settings',...authorized,asyncRoute(async(req,res)=>{
  const body=req.body;if(!['manual','cloud'].includes(body.mode)||typeof body.receiptDrafts!=='boolean')throw new AppError(400,'INVALID_NOTIFICATION_SETTINGS','إعدادات التنبيهات غير صالحة');
  const templates={};for(const type of ['receipt','reminder','product','staff','general']){const name=body.templates?.[type]||'';if(name&&!/^[a-z0-9_]{1,512}$/.test(name))throw new AppError(400,'INVALID_TEMPLATE','اسم قالب واتساب غير صالح');templates[type]=name;}
  const language=body.language||'ar';if(!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language))throw new AppError(400,'INVALID_LANGUAGE','رمز اللغة غير صالح');
  await store.saveSalesSetting('notification-settings:'+req.auth.company.id,{companyId:req.auth.company.id,mode:body.mode,receiptDrafts:body.receiptDrafts,automaticReceipts:body.automaticReceipts===true,templates,language},req.auth.user.id);
  res.json({saved:true});
 }));
 app.put('/api/v1/notifications/consent',...authorized,asyncRoute(async(req,res)=>{const phone=whatsappPhone(req.body.phone);if(typeof req.body.optIn!=='boolean')throw new AppError(400,'INVALID_CONSENT','حدد موافقة المستلم');await store.saveSalesSetting('notification-consent:'+req.auth.company.id+':'+phone,{companyId:req.auth.company.id,phone,optIn:req.body.optIn,recordedAt:new Date().toISOString(),recordedBy:req.auth.user.id},req.auth.user.id);res.json({saved:true});}));
 app.post('/api/v1/notifications/:id/send',...authorized,asyncRoute(async(req,res)=>{
  const message=store.customerNotifications.get(req.params.id),companyId=req.auth.company.id;if(!message||message.companyId!==companyId)throw new AppError(404,'MESSAGE_NOT_FOUND','الرسالة غير موجودة');
  if(['sending','uncertain','accepted','sent','delivered','read'].includes(message.status))return res.json({message});
  const settings=store.salesSettings.get('notification-settings:'+companyId);if(settings?.mode!=='cloud'||!settings.templates?.[message.type])throw new AppError(400,'TEMPLATE_REQUIRED','حدد طريقة الربط الرسمي والقالب المعتمد');
  if(!store.salesSettings.get('notification-consent:'+companyId+':'+message.phone)?.optIn)throw new AppError(400,'CONSENT_REQUIRED','سجّل موافقة المستلم على رسائل واتساب أولًا');
  // Queue only. The cloud worker sends after the transaction is durable.
  await store.saveNotificationState(companyId,message.id,{status:'queued',error:null,queuedAt:new Date().toISOString()},req.auth.user.id);res.json({message:store.customerNotifications.get(message.id)});
 }));
 app.post('/api/v1/notifications',...authorized,asyncRoute(async(req,res)=>{
  const body=req.body,companyId=req.auth.company.id;
  let recipient;
  if(body.recipientType==='other')recipient={type:'other',id:null,name:String(body.name||'').trim(),phone:body.phone};
  else recipient=notificationContacts(store,companyId).find(x=>x.type===body.recipientType&&x.id===body.recipientId);
  if(!recipient||!recipient.name||recipient.name.length>120)throw new AppError(400,'INVALID_RECIPIENT','اختر مستلمًا صالحًا');
  const phone=whatsappPhone(body.phone||recipient.phone);
  if(!['reminder','product','staff','general'].includes(body.type)||typeof body.text!=='string'||!body.text.trim()||body.text.length>4000)throw new AppError(400,'INVALID_MESSAGE','اكتب الرسالة بحد أقصى 4000 حرف');
  const operationId=body.operationId||randomUUID();if(!/^[0-9a-f-]{36}$/i.test(operationId))throw new AppError(400,'INVALID_OPERATION_ID','معرف الرسالة غير صالح');
  let itemId=null,image='';
  if(body.itemId){const item=store.items.get(body.itemId);if(!item||item.companyId!==companyId)throw new AppError(404,'ITEM_NOT_FOUND','الصنف غير موجود');itemId=item.id;image=item.image||'';}
  const input={operationId,recipientType:recipient.type,recipientId:recipient.id,recipientName:recipient.name,customerId:recipient.type==='customer'?recipient.id:null,phone,type:body.type,text:body.text.trim(),itemId,image};
  res.status(201).json({message:await store.prepareCustomerNotification(companyId,input,req.auth.user.id)});
 }));
 app.post('/api/v1/notifications/:id/opened',...authorized,asyncRoute(async(req,res)=>{
  res.json({message:await store.markCustomerNotificationOpened(req.auth.company.id,req.params.id,req.auth.user.id)});
 }));
}
