(()=>{'use strict';if(window.AlMahasibRuntimeUI)return;window.AlMahasibRuntimeUI=true;
 const editable='input:not([type=hidden]):not([type=button]):not([type=submit]):not([disabled]):not([readonly]),textarea:not([disabled]):not([readonly]),[contenteditable="true"]';
 function focusEditor(field){if(!field?.isConnected||!field.matches?.(editable))return;window.AlMahasibDesktop?.focusEditor();requestAnimationFrame(()=>{if(field.isConnected)field.focus({preventScroll:true});});}
 document.addEventListener('pointerdown',event=>{const field=event.target.closest?.(editable);if(field)focusEditor(field);},true);
 const show=HTMLDialogElement.prototype.showModal;
 HTMLDialogElement.prototype.showModal=function(...args){const previous=document.activeElement;const result=show.apply(this,args);this.addEventListener('close',()=>focusEditor(previous),{once:true});focusEditor(this.querySelector('[autofocus]')||this.querySelector(editable));return result;};
 if(window.AlMahasibDesktop){window.confirm=text=>window.AlMahasibDesktop.confirm(text);window.alert=text=>window.AlMahasibDesktop.alert(text);window.addEventListener('focus',()=>focusEditor(document.activeElement));}
 window.AlMahasibAsk=(message,value='')=>new Promise(resolve=>{
  const dialog=document.createElement('dialog'),form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('textarea'),buttons=document.createElement('div'),save=document.createElement('button'),cancel=document.createElement('button');
  dialog.className='company-input-dialog';dialog.dir='rtl';label.textContent=message;input.value=String(value??'');input.rows=3;input.autofocus=true;save.textContent='موافق';cancel.textContent='إلغاء';cancel.type='button';buttons.className='actions';buttons.append(save,cancel);label.append(input);form.append(label,buttons);dialog.append(form);document.body.append(dialog);
  let answer=null;form.onsubmit=event=>{event.preventDefault();answer=input.value;dialog.close();};cancel.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dialog.remove();resolve(answer);},{once:true});dialog.showModal();
 });
 const style=document.createElement('style');style.textContent='.company-network-status{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px}.company-network-status span{padding:5px 8px;border-radius:18px;background:#f2f5f6;color:#55626b;white-space:nowrap}.company-network-status .online{color:#087739;background:#e6f7ed}.company-network-status .offline{color:#b42318;background:#fff0ed}.company-network-status .checking{color:#667085}.company-input-dialog{width:min(500px,90vw);border:1px solid #dce5eb;border-radius:16px;padding:24px;direction:rtl}.company-input-dialog form,.company-input-dialog label{display:grid;gap:14px}.company-input-dialog textarea{width:100%;min-height:90px}.company-input-dialog .actions{display:flex;gap:10px}';document.head.append(style);
 const bar=document.createElement('div');bar.className='company-network-status';bar.setAttribute('role','status');bar.setAttribute('aria-live','polite');
 const internet=document.createElement('span'),cloud=document.createElement('span');bar.append(internet,cloud);
 function badge(element,label,value){element.className=value===null?'checking':value?'online':'offline';element.textContent='● '+label;}
 badge(internet,'الإنترنت: جارٍ الفحص',null);badge(cloud,'السحابة: جارٍ الفحص',null);
 let mode,busy=false;
 const rawFetch=window.fetch.bind(window);
 async function check(){if(busy)return;busy=true;try{
  if(mode===undefined){const response=await rawFetch('/api/local/status',{cache:'no-store',signal:AbortSignal.timeout(7000)});const data=await response.json();mode=data.local===true;}
  if(!bar.isConnected){const anchor=document.getElementById('connection');if(anchor)anchor.after(bar);else{bar.style.cssText='position:fixed;bottom:74px;left:18px;z-index:44';document.body.append(bar);}}
  let data;if(mode){const response=await rawFetch('/api/local/connectivity',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('تعذر الفحص');data=await response.json();}
  else{const response=await rawFetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(7000)});const health=await response.json();const online=response.ok&&health.ok===true;data={internet:online,cloud:online,linked:true,checkedAt:new Date().toISOString()};}
  badge(internet,data.internet?'الإنترنت متصل':'الإنترنت غير متاح',data.internet===true);
  badge(cloud,!data.linked?'السحابة غير مربوطة':data.cloud?'السحابة متصلة'+(data.synchronizationError?' · المزامنة متعثرة':''):'السحابة غير متاحة',data.linked===true&&data.cloud===true);
  const checked=new Date(data.checkedAt).toLocaleTimeString('ar-IQ');internet.title='آخر فحص فعلي: '+checked;
  cloud.title='آخر فحص: '+checked+(data.lastSuccessfulSync?' · آخر مزامنة ناجحة: '+new Date(data.lastSuccessfulSync).toLocaleString('ar-IQ'):' · لم تُسجل مزامنة ناجحة')+(data.synchronizationError?' · توجد مشكلة في المزامنة؛ راجع العمليات المحفوظة':'')+(data.automatic===false?' · المزامنة التلقائية متوقفة':'');
 }catch{badge(internet,'تعذر التحقق من الإنترنت',false);badge(cloud,'تعذر التحقق من السحابة',false);}finally{busy=false;}}
 window.addEventListener('online',()=>void check());window.addEventListener('offline',()=>{badge(internet,'الإنترنت غير متاح',false);badge(cloud,'السحابة غير متاحة',false);});document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void check(),{once:true});else void check();setInterval(()=>{if(!document.hidden)void check();},20000);
})();
