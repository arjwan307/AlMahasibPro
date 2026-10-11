(() => {
 'use strict';
 let account,operation;
 const el=id=>document.getElementById(id),status=el('status');
 async function api(path,method='GET',body){const response=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error?.message||'تعذر تنفيذ العملية');return data;}
 const run=(form,path)=>{form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await api(path,'PATCH',Object.fromEntries(new FormData(form)));status.textContent='حُفظ التعديل وسُجل في التدقيق';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};};
 run(el('profile'),'/api/v1/settings/profile');run(el('company'),'/api/v1/settings/company');
 function confirmOperation(kind,title){operation=kind;el('destroy').reset();el('operation').textContent=title;el('phrase').textContent=kind==='transfer'?'TRANSFER OWNER '+account.company.code:account.confirmation[kind];el('warning').textContent=kind==='transfer'?'ستنتقل ملكية الشركة إلى المسؤول المحدد.':kind==='local'?'تُمسح نسخة هذه الشركة على الجهاز مع فصل المزامنة. السحابة تبقى محفوظة.':kind==='account'?'سيتوقف دخولك بعد التنفيذ. بيانات الشركة تبقى محفوظة.':'ستُحذف هذه الشركة وبياناتها السحابية نهائيًا وتُلغى جلساتها.';el('dialogStatus').textContent='';el('confirmation').showModal();}
 el('transferOwner').onclick=()=>confirmOperation('transfer','نقل ملكية الشركة');
 el('deleteAccount').onclick=()=>confirmOperation('account','حذف حسابي');el('eraseLocal').onclick=()=>confirmOperation('local','مسح النسخة المحلية');el('deleteCompany').onclick=()=>confirmOperation('company','حذف الشركة السحابية');el('cancel').onclick=()=>el('confirmation').close();
 el('destroy').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{
   const body={...Object.fromEntries(new FormData(event.target)),confirm:true};
   if(body.confirmation!==(operation==='transfer'?'TRANSFER OWNER '+account.company.code:account.confirmation[operation]))throw Error('عبارة التأكيد غير مطابقة');
   if(operation==='transfer')body.newOwnerId=el('newOwner').value;
   const path=operation==='transfer'?(account.local&&account.accountDeletion==='cloud'?'/api/local/settings/transfer-owner':'/api/v1/settings/transfer-owner'):operation==='local'?'/api/local/settings/erase-company':account.local&&!(operation==='account'&&account.accountDeletion==='local')?'/api/local/settings/delete-cloud-'+operation:'/api/v1/settings/delete-'+operation;
   await api(path,'POST',body);
   event.target.reset();
   if(operation==='transfer'){location.reload();return;}
   if(operation!=='account')await window.AlMahasibERP?.purgeCompany(account.company.id);
   location.replace('/login.html');
 }catch(error){el('dialogStatus').textContent=error.message;}finally{button.disabled=false;}};
 (async()=>{try{
   account=await api('/api/v1/settings');el('identity').textContent=account.company.legalName+' · '+account.company.code+' · '+account.user.displayName;
   el('profile').elements.displayName.value=account.user.displayName;
   for(const key of ['legalName','phone','address'])el('company').elements[key].value=account.company[key]||'';
   for(const input of el('company').elements)input.disabled=!account.permissions.includes('company.manage')||!account.supported;
   el('deleteAccount').disabled=!account.permissions.includes('account.delete')||!account.supported;
   el('deleteCompany').disabled=!account.permissions.includes('company.delete')||!account.supported||account.local&&!account.cloudLinked;
   el('eraseLocal').hidden=!account.local;el('eraseLocal').disabled=!account.permissions.includes('local.data.delete')||!account.supported;
   if(account.company.ownerUserId===account.user.id&&account.permissions.includes('users.manage')){
     const users=await api('/api/v1/users');
     for(const user of users.users.filter(user=>user.id!==account.user.id&&user.status==='active'&&user.permissions.includes('company.manage')&&user.permissions.includes('users.manage'))){const option=document.createElement('option');option.value=user.id;option.textContent=user.displayName+' · '+user.username;el('newOwner').append(option);}
     el('ownership').hidden=false;el('transferOwner').disabled=!el('newOwner').options.length;
   }
   el('permissionNote').textContent='صلاحيات الحذف لا تُمنح تلقائيًا للأدوار؛ يجب على مسؤول مخوّل منحها صراحة للحساب.';
 }catch(error){status.textContent=error.message;for(const button of document.querySelectorAll('button'))button.disabled=true;}})();
})();
