import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
export function whatsappConfigured(companyId,env=process.env){return !!(env.WHATSAPP_TOKEN&&/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID||'')&&/^v\d+\.\d+$/.test(env.WHATSAPP_API_VERSION||'')&&env.WHATSAPP_COMPANY_ID===companyId);}
export function verifyWhatsAppSignature(bytes,signature,secret){if(!secret||!Buffer.isBuffer(bytes)||!/^sha256=[0-9a-f]{64}$/.test(signature||''))return false;const expected=createHmac('sha256',secret).update(bytes).digest(),actual=Buffer.from(signature.slice(7),'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export async function sendWhatsAppTemplate(message,settings,{env=process.env,fetcher=fetch}={}){
 if(!whatsappConfigured(message.companyId,env))throw Error('بيانات حساب WhatsApp Business غير مكتملة لهذه الشركة');
 const name=settings.templates?.[message.type];if(!/^[a-z0-9_]{1,512}$/.test(name||''))throw Error('حدد اسم قالب واتساب المعتمد لنوع الرسالة');
 const language=settings.language||'ar';if(!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language))throw Error('لغة القالب غير صالحة');
 const root=`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}`;
 const components=[];
 if(message.image){
  const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(message.image);if(!match)throw Error('صورة الرسالة غير صالحة');
  const form=new FormData();form.set('messaging_product','whatsapp');form.set('file',new Blob([Buffer.from(match[2],'base64')],{type:match[1]}),'product.'+match[1].split('/')[1]);
  const uploaded=await fetcher(root+'/media',{method:'POST',headers:{Authorization:'Bearer '+env.WHATSAPP_TOKEN},body:form,signal:AbortSignal.timeout(30000)});
  const media=await uploaded.json();if(!uploaded.ok||!media.id){const error=Error('رفضت خدمة واتساب صورة الرسالة');error.definitive=true;throw error;}
  components.push({type:'header',parameters:[{type:'image',image:{id:media.id}}]});
 }
 const parameters=message.type==='receipt'?[message.customerName||message.recipientName,message.amount,message.currency,message.reference]:[message.recipientName||message.customerName||'',message.text];
 components.push({type:'body',parameters:parameters.map(text=>({type:'text',text:String(text||'')}))});
 const response=await fetcher(root+'/messages',{method:'POST',headers:{Authorization:'Bearer '+env.WHATSAPP_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:message.phone,type:'template',template:{name,language:{code:language},components},biz_opaque_callback_data:message.callbackId||message.id}),signal:AbortSignal.timeout(30000)});
 let body;try{body=await response.json();}catch{throw Error('لم يصل تأكيد واضح من خدمة واتساب');}
 if(!response.ok){const error=Error('رفضت خدمة واتساب الرسالة'+(body.error?.code?' (رمز '+body.error.code+')':''));error.definitive=response.status>=400&&response.status<500&&![408,429].includes(response.status);throw error;}
 if(!body.messages?.[0]?.id)throw Error('لم يصل معرف الرسالة من خدمة واتساب');return body.messages[0].id;
}
export async function deliverNotification(store,id,options={}){
 let claimed;
 await store.transaction(()=>{
  const message=store.customerNotifications.get(id);if(!message||!['draft','queued'].includes(message.status))return;
  const settings=store.salesSettings.get('notification-settings:'+message.companyId);
  const consent=store.salesSettings.get('notification-consent:'+message.companyId+':'+message.phone);
  if(settings?.mode!=='cloud'||!consent?.optIn||!whatsappConfigured(message.companyId,options.env||process.env))return;
  if(message.status==='draft'&&(message.type!=='receipt'||!settings.automaticReceipts))return;
  if(!settings.templates?.[message.type])return;
  claimed={message:{...message},settings,attempt:randomUUID()};claimed.message.callbackId=message.id+':'+claimed.attempt;store.customerNotifications.set(id,{...message,status:'sending',attemptId:claimed.attempt,activeCallbackId:claimed.message.callbackId,attemptedAt:new Date().toISOString()});
 });
 if(!claimed)return false;
 try{
  const providerId=await sendWhatsAppTemplate(claimed.message,claimed.settings,options);
  await store.transaction(()=>{const row=store.customerNotifications.get(id);if(row?.attemptId===claimed.attempt)store.customerNotifications.set(id,{...row,providerId,status:['delivered','read','sent'].includes(row.status)?row.status:'accepted',acceptedAt:new Date().toISOString(),error:null});});
 }catch(error){await store.transaction(()=>{const row=store.customerNotifications.get(id);if(row?.attemptId===claimed.attempt&&row.status==='sending')store.customerNotifications.set(id,{...row,status:error.definitive?'failed':'uncertain',error:error.message});});}
 return true;
}
export function startNotificationWorker(store){
 let busy=false;
 const timer=setInterval(async()=>{if(busy)return;busy=true;try{for(const row of store.customerNotifications.values()){
   if(row.status==='sending'&&Date.now()-Date.parse(row.attemptedAt)>120000)await store.transaction(()=>{const current=store.customerNotifications.get(row.id);if(current?.status==='sending')store.customerNotifications.set(row.id,{...current,status:'uncertain',error:'انقطع تأكيد الإرسال؛ راجع حالة الرسالة قبل إعادة الإرسال'});});
   if(['draft','queued'].includes(row.status))await deliverNotification(store,row.id);
  }}catch{}finally{busy=false;}},15000);timer.unref();return ()=>clearInterval(timer);
}
