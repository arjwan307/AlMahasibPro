(()=>{'use strict';
const root=document.getElementById('assistantRoot'),workspace=document.getElementById('workspace');
if(!root||!workspace)return;
const launcher=document.getElementById('assistantLauncher'),panel=document.getElementById('assistantPanel'),status=document.getElementById('assistantStatus'),messagesBox=document.getElementById('assistantMessages'),form=document.getElementById('assistantForm'),input=form.elements.message,send=form.querySelector('button');
const history=[];let ready=false,busy=false;
const addMessage=(text,role,error=false)=>{const node=document.createElement('div');node.className='assistant-bubble '+(role==='user'?'user':'bot')+(error?' assistant-error':'');node.textContent=text;messagesBox.append(node);messagesBox.scrollTop=messagesBox.scrollHeight;};
async function api(url,options={}){const response=await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||'تعذر الاتصال بالمساعد');return data;}
async function checkStatus(){status.textContent='يتحقق من الاتصال السحابي…';try{const data=await api('/api/v1/assistant/status',{signal:AbortSignal.timeout(8000)});ready=Boolean(data.available);status.textContent=data.available?'متصل سحابيًا · '+data.model:data.configured?'المساعد السحابي غير متاح: '+data.model:'لم يُضبط مفتاح المساعد السحابي على الخادم';}catch{ready=false;status.textContent='تعذر التحقق الآن؛ جرّب إرسال رسالتك مباشرة.';}}
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
