(() => {'use strict';
 const form=document.getElementById('login'),notice=document.getElementById('notice');let localMode=false;
 async function request(path,body){const response=await fetch(path,{credentials:'same-origin',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error?.message||'تعذر الاتصال');return data;}
 function route(account){
  if(!account?.company?.id)throw Error('سجّل الدخول بحساب منشأة معتمد');
  const company=account.company;
  const code=String(company.code||'').trim().toUpperCase();
  const prefix=code.match(/^(CO|RE|MA)(?=\d|[-_]|$)/)?.[1];
  const kind=prefix==='CO'?'company':prefix==='RE'?'restaurant':prefix==='MA'?'market':company.product==='retail'?'retail':'company';
  localStorage.setItem('almahasib_company_context',JSON.stringify({id:company.id,code:company.code,name:company.legalName,kind}));
  location.replace(kind==='company'?'/enterprise.html':(localMode?'/retail.html':'/retail/retail.html'));
 }
 form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector(':scope > button');button.disabled=true;notice.hidden=true;try{const result=await request('/api/v1/auth/login',Object.fromEntries(new FormData(form)));route(result.account);}catch(error){notice.textContent=error.message;notice.hidden=false;}finally{button.disabled=false;}};
 (async()=>{try{const status=await request('/api/local/status');localMode=Boolean(status.local);if(localMode&&status.companyCode)form.elements.companyCode.value=status.companyCode;}catch{}try{route(await request('/api/v1/bootstrap'));}catch{}})();
})();
