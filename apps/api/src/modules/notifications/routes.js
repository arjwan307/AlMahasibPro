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

export function installNotificationRoutes(app,{store,authenticate,permit}){
 const authorized=[authenticate(store),permit('company.manage')];
 app.get('/api/v1/notifications',...authorized,(req,res)=>{
  const companyId=req.auth.company.id;
  res.json({contacts:notificationContacts(store,companyId),messages:[...store.customerNotifications.values()].filter(x=>x.companyId===companyId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,300),settings:store.salesSettings.get('notification-settings:'+companyId)||{mode:'manual',receiptDrafts:true},cloudConfigured:!!(process.env.WHATSAPP_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID&&process.env.WHATSAPP_API_VERSION)});
 });
 app.put('/api/v1/notifications/settings',...authorized,asyncRoute(async(req,res)=>{
  const body=req.body;if(!['manual','cloud'].includes(body.mode)||typeof body.receiptDrafts!=='boolean')throw new AppError(400,'INVALID_NOTIFICATION_SETTINGS','إعدادات التنبيهات غير صالحة');
  // Switching the preference never sends messages or pretends a provider is connected.
  await store.saveSalesSetting('notification-settings:'+req.auth.company.id,{companyId:req.auth.company.id,mode:body.mode,receiptDrafts:body.receiptDrafts},req.auth.user.id);
  res.json({saved:true});
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
