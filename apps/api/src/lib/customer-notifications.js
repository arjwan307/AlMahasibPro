import { AppError } from './http.js';

export function whatsappPhone(value){
 const normalized=String(value||'').replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x0660)).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x06f0)).replace(/[\s()+.-]/g,'');
 const phone=normalized.startsWith('00')?normalized.slice(2):/^07\d{9}$/.test(normalized)?'964'+normalized.slice(1):normalized;
 if(!/^[1-9]\d{7,14}$/.test(phone))throw new AppError(400,'INVALID_WHATSAPP_PHONE','أدخل هاتف الزبون مع رمز الدولة؛ الرقم العراقي يمكن إدخاله بصيغة 07xxxxxxxxx');
 return phone;
}

// Event identifiers are business operation IDs, so replay never creates a second message.
export function receiptNotification(store,companyId,customerId,{operationId,sourceId,reference,amount,currency}){
 if(!customerId||!operationId)return;
 const customer=store.customers.get(customerId),company=store.companies.get(companyId);
 if(!customer||customer.companyId!==companyId||!customer.phone)return;
 const settings=store.salesSettings.get('notification-settings:'+companyId);
 if(settings?.receiptDrafts===false)return;
 const eventKey=companyId+':receipt:'+operationId;
 if(store.customerNotifications.has(eventKey))return;
 let phone;try{phone=whatsappPhone(customer.phone);}catch{return;}
 const row={id:eventKey,companyId,customerId,type:'receipt',sourceId,reference,amount,currency,phone,customerName:customer.name,status:'draft',createdAt:new Date().toISOString(),text:`السيد/السيدة ${customer.name}، تم اعتماد تسديدكم لدى ${company.legalName} بمبلغ ${amount} ${currency}. المرجع: ${reference}. شكرًا لتعاملكم معنا.`};
 store.customerNotifications.set(eventKey,row);
}
