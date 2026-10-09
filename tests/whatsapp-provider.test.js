import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac} from 'node:crypto';
import {SQLiteStore} from '../apps/api/src/store/sqlite-store.js';
import {deliverNotification,verifyWhatsAppSignature,whatsappConfigured} from '../apps/api/src/lib/whatsapp-provider.js';

test('official WhatsApp queues send once after consent; ambiguous provider response never retries automatically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'whatsapp-provider-'));const store=new SQLiteStore(join(dir,'test.sqlite'));
 try{
  const env={WHATSAPP_TOKEN:'test-secret',WHATSAPP_PHONE_NUMBER_ID:'123',WHATSAPP_API_VERSION:'v25.0',WHATSAPP_COMPANY_ID:'co'};
  assert.equal(whatsappConfigured('other',env),false);
  const message={id:'co:receipt:operation',companyId:'co',type:'receipt',customerName:'زبون',amount:'20',currency:'IQD',reference:'R1',phone:'9647807807491',status:'draft'};
  await store.transaction(()=>{store.customerNotifications.set(message.id,message);store.salesSettings.set('notification-settings:co',{mode:'cloud',automaticReceipts:true,language:'ar',templates:{receipt:'receipt_confirm'}});});
  let calls=0,payload;
  const fetcher=async(url,options)=>{calls++;payload=JSON.parse(options.body);assert.equal(store.customerNotifications.get(message.id).status,'sending','claim committed before provider call');return new Response(JSON.stringify({messages:[{id:'wamid.test'}]}),{status:200});};
  assert.equal(await deliverNotification(store,message.id,{env,fetcher}),false);assert.equal(calls,0);
  await store.saveSalesSetting('notification-consent:co:'+message.phone,{companyId:'co',phone:message.phone,optIn:true},'owner');
  await Promise.all([deliverNotification(store,message.id,{env,fetcher}),deliverNotification(store,message.id,{env,fetcher})]);
  assert.equal(calls,1);assert.equal(payload.type,'template');assert.equal(payload.template.name,'receipt_confirm');assert.equal(payload.biz_opaque_callback_data,message.id);assert.equal(store.customerNotifications.get(message.id).status,'accepted');
  await store.transaction(()=>store.customerNotifications.set('uncertain',{...message,id:'uncertain'}));
  const missing=async()=>{calls++;throw Error('lost response');};
  await deliverNotification(store,'uncertain',{env,fetcher:missing});assert.equal(store.customerNotifications.get('uncertain').status,'uncertain');
  await deliverNotification(store,'uncertain',{env,fetcher:missing});assert.equal(calls,2);
  const bytes=Buffer.from('{"entry":[]}'),signature='sha256='+createHmac('sha256','secret').update(bytes).digest('hex');assert.equal(verifyWhatsAppSignature(bytes,signature,'secret'),true);assert.equal(verifyWhatsAppSignature(Buffer.from('changed'),signature,'secret'),false);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
