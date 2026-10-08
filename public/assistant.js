(()=>{'use strict';
const root=document.getElementById('assistantRoot'),workspace=document.getElementById('workspace');
if(!root||!workspace)return;
const launcher=document.getElementById('assistantLauncher'),panel=document.getElementById('assistantPanel'),status=document.getElementById('assistantStatus'),messagesBox=document.getElementById('assistantMessages'),form=document.getElementById('assistantForm'),input=form.elements.message,send=form.querySelector('button');
const history=[];let ready=false,busy=false;
const addMessage=(text,role,error=false)=>{const node=document.createElement('div');node.className='assistant-bubble '+(role==='user'?'user':'bot')+(error?' assistant-error':'');node.textContent=text;messagesBox.append(node);messagesBox.scrollTop=messagesBox.scrollHeight;};
async function api(url,options={}){const timeout=AbortSignal.timeout(url.endsWith('/chat')?27000:9000);const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;let response;try{response=await fetch(url,{credentials:'same-origin',...options,signal,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});}catch(error){if(['TimeoutError','AbortError'].includes(error?.name))throw new Error('انتهت مهلة انتظار المساعد؛ أعد المحاولة بعد قليل');throw new Error('تعذر الاتصال بخادم المساعد؛ تحقق من الاتصال ثم أعد المحاولة');}const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||'تعذر الاتصال بالمساعد');return data;}
async function checkStatus(){status.textContent='يتحقق من الاتصال السحابي…';try{const data=await api('/api/v1/assistant/status',{signal:AbortSignal.timeout(8000)});ready=Boolean(data.available);const reasons={ASSISTANT_PROVIDER_AUTH:'مفتاح مزود الذكاء غير مقبول',ASSISTANT_RATE_LIMITED:'تجاوز المزود حد الاستخدام المؤقت',ASSISTANT_PROVIDER_TIMEOUT:'انتهت مهلة الاتصال بمزود الذكاء',ASSISTANT_PROVIDER_UNAVAILABLE:'الخادم لا يصل إلى مزود الذكاء'};status.textContent=data.available?'متصل سحابيًا · '+data.model:data.errorCode?(reasons[data.errorCode]||'المساعد السحابي غير متاح')+' · جرّب الإرسال بعد قليل':data.configured?'المساعد السحابي غير متاح: '+data.model:'لم يُضبط مفتاح المساعد السحابي على الخادم';}catch{ready=false;status.textContent='تعذر فحص المزود الآن؛ يمكنك إرسال رسالة للمساعد.';}}
function show(){panel.hidden=false;launcher.setAttribute('aria-expanded','true');input.focus();}
function hide(){panel.hidden=true;launcher.setAttribute('aria-expanded','false');}
launcher.addEventListener('click',()=>panel.hidden?show():hide());document.getElementById('assistantClose').addEventListener('click',hide);
form.addEventListener('submit',async event=>{event.preventDefault();const text=input.value.trim();if(!text||busy)return;
 busy=true;send.disabled=true;input.value='';addMessage(text,'user');history.push({role:'user',content:text});
 try{const data=await api('/api/v1/assistant/chat',{method:'POST',body:JSON.stringify({messages:history.slice(-12)})});history.push({role:'assistant',content:data.answer});addMessage(data.answer,'assistant');}
 catch(error){addMessage(error.message,'assistant',true);}
 finally{busy=false;send.disabled=false;input.focus();}
});
const observer=new MutationObserver(()=>{if(!workspace.hidden){root.hidden=false;observer.disconnect();checkStatus();}});observer.observe(workspace,{attributes:true,attributeFilter:['hidden']});
if(!workspace.hidden){root.hidden=false;checkStatus();}else if(sessionStorage.getItem('almahasib_login_success')==='1'){root.hidden=false;checkStatus();}
})();
