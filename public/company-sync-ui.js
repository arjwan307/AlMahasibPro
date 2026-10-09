(() => {
 'use strict';
 const $=id=>document.getElementById(id),context=()=>window.AlMahasibOutput?.();
 let accountKey,loading,running=false;
 function notify(text){$('notice').textContent=text;$('notice').hidden=false;setTimeout(()=>$('notice').hidden=true,7000);}
 async function engine(){
  const account=context()?.account;if(!account)throw Error('سجّل الدخول أولًا');
  if(window.AlMahasibOffline){const loaded=window.AlMahasibOffline.account();if(loaded?.company.id!==account.company.id||loaded?.user.id!==account.user.id)await window.AlMahasibOffline.initialize();return window.AlMahasibOffline;}
  if(!loading)loading=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/offline-sync.js?v=20261010-controls';script.onload=()=>resolve();script.onerror=()=>reject(Error('تعذر تحميل المزامنة'));document.head.append(script);});
  await loading;
  for(let i=0;i<60&&!window.AlMahasibOffline;i++)await new Promise(r=>setTimeout(r,100));
  if(!window.AlMahasibOffline)throw Error('تعذر تهيئة المزامنة؛ تحقق من الاتصال وصلاحية الجلسة');return window.AlMahasibOffline;
 }
 async function update(){
  if(context()?.local)return;
  try{const client=await engine(),status=await client.status(),badge=$('companySyncStatus'),auto=$('companyAutoSync');if(auto)auto.checked=status.automatic;if(badge)badge.textContent=`بانتظار الإرسال: ${status.pending} · تحتاج مراجعة: ${status.conflicts} · آخر مزامنة: ${status.lastSuccessfulSync?new Date(status.lastSuccessfulSync).toLocaleString('ar-IQ'):'لم تتم بعد'}`;}catch(error){if($('companySyncStatus'))$('companySyncStatus').textContent=error.message;}
 }
 async function manual(){
  if(running)return;running=true;const button=$('companySyncNow');button.disabled=true;
  try{const client=await engine(),result=await client.synchronize();if(result?.state==='failed')throw Error(result.message);if(result?.state==='offline')throw Error('لا يوجد اتصال؛ العمليات المحفوظة تبقى بانتظار الإرسال');if(result?.state==='busy')return;if(result?.state!=='complete')throw Error('المزامنة غير جاهزة');await context().refresh();notify(result.conflicts?'اكتملت المزامنة؛ توجد عمليات تحتاج مراجعة':'اكتملت المزامنة');await update();}catch(error){notify(error.message);}finally{button.disabled=false;running=false;}
 }
 function decorate(){
  const c=context(),heading=document.querySelector('.page-heading');if(!c?.account||$('workspace')?.hidden||!heading)return;
  const key=c.account.company.id+':'+c.account.user.id;
  if(!document.getElementById('companySyncPanel')){const panel=document.createElement('details');panel.id='companySyncPanel';panel.className='panel';panel.innerHTML='<summary>النسخ الاحتياطي والمزامنة</summary><div class="actions" style="margin:14px 0"><button type="button" id="companyBackupNow">أخذ نسخة احتياطية</button><button type="button" id="companySyncNow">مزامنة الآن</button><label><input type="checkbox" id="companyAutoSync"> مزامنة تلقائية كل دقيقة وعند عودة الاتصال</label></div><p class="muted" id="companySyncStatus"></p>';heading.after(panel);$('companySyncNow').onclick=manual;$('companyAutoSync').onchange=async e=>{try{(await engine()).setAutomatic(e.target.checked);await update();}catch(err){notify(err.message);}};$('companyBackupNow').onclick=async()=>{const b=$('companyBackupNow');b.disabled=true;try{const r=await fetch('/api/v1/enterprise/backup',{credentials:'same-origin'});if(!r.ok){const result=await r.json();throw Error(result.error?.message||'تعذر أخذ النسخة');}const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='AlMahasibPro-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);notify('أُعدّت النسخة الاحتياطية للتنزيل');}catch(error){notify(error.message);}finally{b.disabled=false;}};}
  if(accountKey===key)return;accountKey=key;
  $('companyBackupNow').hidden=!c.account.permissions.includes('company.manage');
  const syncAllowed=c.account.permissions.includes('sync.use');$('companySyncPanel').hidden=!syncAllowed&&!c.account.permissions.includes('company.manage');
  $('companySyncNow').disabled=c.local||!syncAllowed;$('companyAutoSync').disabled=c.local||!syncAllowed;
  if(c.local)$('companySyncStatus').textContent='البيانات محفوظة محليًا. ربط المزامنة مع السحابة للنسخة الجديدة ما زال قيد التجهيز؛ لا يُعرض الحفظ المحلي كمزامنة سحابية.';
  else if(syncAllowed)void update();
 }
 window.addEventListener('almahasib:sync',()=>{void update();});
 new MutationObserver(decorate).observe(document.body,{childList:true,subtree:true});decorate();
})();
