(() => {
 'use strict';
 const rawFetch=window.fetch.bind(window), ACTIVE='almahasib_erp_active_v1';
 if(!crypto.randomUUID)crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
 let account,db,ready,flushing=false,reachable=false,localServer=false,flushPromise,cloud,lan,usingLan=false;
 const routes=new Map([
  ['/api/v1/commerce/commit',['sales.create','purchasing.create']],
  ['/api/v1/inventory/receipts',['inventory.receive','inventory.manage']],
  ['/api/v1/inventory/issues',['inventory.issue','inventory.manage']],
  ['/api/v1/enterprise/transfers',['inventory.manage']]
 ]);
 const readPaths=new Set(['/api/v1/bootstrap','/api/local/status','/api/v1/master-data','/api/v1/commerce/documents','/api/v1/enterprise/reports','/api/v1/inventory/operations','/api/v1/pos/bootstrap','/api/v1/representatives/bootstrap','/api/v1/users','/api/v1/hr/bootstrap','/api/v1/treasury/cashboxes','/api/v1/import/shipments']);
 const valid=()=>account&&Date.parse(account.offlineSessionExpiresAt)>Date.now();
 const read=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
 async function open(value){
  const signature=JSON.stringify([value.company.id,value.user.id,[...(value.permissions||[])].sort(),value.scopes||[]]);
  if(db&&signature===account?.offlineSignature){account={...value,offlineSignature:signature};return;}
  db?.close();account={...value,offlineSignature:signature};
  db=await new Promise((ok,no)=>{const r=indexedDB.open('almahasib-erp-'+value.company.id+'-'+value.user.id,1);r.onupgradeneeded=()=>{r.result.createObjectStore('reads',{keyPath:'path'});r.result.createObjectStore('outbox',{keyPath:'id'});};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
  localStorage.setItem(ACTIVE,JSON.stringify(account));
  const setting=await read(db.transaction('reads').objectStore('reads').get('@lan'));lan=setting?.data;
 }
 async function rows(store){await ready;return db?read(db.transaction(store).objectStore(store).getAll()):[];}
 async function put(store,row){return new Promise((ok,no)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(row);t.oncomplete=ok;t.onerror=()=>no(t.error);t.onabort=()=>no(t.error||Error('تعذر الحفظ المحلي'));});}
 function json(body,status=200,offline=false){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...(offline?{'X-AlMahasib-Offline':'true'}:{})}});}
 function error(message,status=503){return json({error:{code:'OFFLINE_UNAVAILABLE',message}},status,true);}
 function connectionText(){return reachable?(usingLan?'مزامنة عبر شبكة الفرع':localServer?'خادم الفرع المحلي متصل':'خادم الشركة متصل'):'قاعدة الجهاز · الخادم غير متصل';}
 async function status(){const queue=await rows('outbox');return{reachable,localServer,cloud,pending:queue.filter(x=>['pending','sending'].includes(x.state)).length,conflicts:queue.filter(x=>x.state==='conflict').length,connection:connectionText()};}
 async function render(){const el=document.getElementById('erpOfflineStatus');if(!el)return;const button=document.getElementById('erpConnectionButton');if(button)button.hidden=!valid();const s=await status();el.textContent=s.connection+' · بانتظار الإرسال: '+s.pending+' · تحتاج مراجعة: '+s.conflicts+(localServer?' · السحابة: '+(cloud?.connected?'مرتبطة؛ آخر مزامنة: '+(cloud.lastSuccessfulSync||'لم تتم بعد'):'لم يُؤكد الربط'):'');window.dispatchEvent(new CustomEvent('almahasib:connection',{detail:s}));}
 function reset(){account=null;db?.close();db=null;lan=null;localStorage.removeItem(ACTIVE);localStorage.removeItem('almahasib_cached_bootstrap');reachable=false;}
 ready=(async()=>{try{const saved=JSON.parse(localStorage.getItem(ACTIVE)||'null');if(saved&&Date.parse(saved.offlineSessionExpiresAt)>Date.now())await open(saved);}catch{reset();}})();
 async function queue(path,body){const save=()=>saveQueue(path,body);return navigator.locks?navigator.locks.request('erp-queue-'+account?.company.id+'-'+account?.user.id,save):save();}
 async function saveQueue(path,body){
  if(!valid())return error('يلزم تسجيل الدخول عبر الخادم أولًا؛ انتهت صلاحية جلسة العمل دون اتصال',401);
  if(!account.permissions?.includes('sync.use'))return error('الحساب لا يملك صلاحية المزامنة',403);
  let needed=routes.get(path);
  if(path==='/api/v1/commerce/commit')needed=[body.document?.documentType?.startsWith('purchase')?'purchasing.create':'sales.create'];
  if(!needed?.some(p=>account.permissions.includes(p)))return error('لا توجد صلاحية لحفظ هذه العملية دون اتصال',403);
  if(!body.operationId)return error('يلزم معرف ثابت للعملية قبل الحفظ');
  const existing=await read(db.transaction('outbox').objectStore('outbox').get(body.operationId));
  if(existing&&JSON.stringify(existing.body)!==JSON.stringify(body))return error('معرف العملية مستخدم لبيانات مختلفة',409);
  if(!existing){
   const cached=await read(db.transaction('reads').objectStore('reads').get('/api/v1/master-data'));
   if(!cached||cached.signature!==account.offlineSignature)return error('نزّل بيانات الأصناف والمخازن قبل حفظ العمليات دون اتصال');
   const master=cached.data;
   const scale=value=>{const s=String(value??'0');if(!/^\d+(\.\d{1,6})?$/.test(s))throw Error('أدخل كمية عشرية موجبة صحيحة');const [a,b='']=s.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));};
   function withdrawals(command){
    let lines=[],warehouse;
    if(command.path==='/api/v1/inventory/issues')lines=command.body.lines||[];
    if(command.path==='/api/v1/enterprise/transfers'){warehouse=command.body.sourceWarehouseId;lines=command.body.lines||[];}
    const doc=command.body.document;
    if(command.path==='/api/v1/commerce/commit'&&['sale','purchase_return'].includes(doc?.documentType)){warehouse=doc.warehouseId;lines=doc.lines||[];}
    return lines.map(line=>{const factor=doc?master.items.find(x=>x.id===line.itemId)?.units?.find(x=>x.unitId===line.unitId)?.conversionFactor||'1':'1';return{key:(line.warehouseId||warehouse)+':'+line.itemId,quantity:scale(line.quantity)*scale(factor)/1000000n};});
   }
   try{
    const balances=new Map((master.stock||[]).map(x=>[x.warehouseId+':'+x.itemId,scale(x.quantity)]));
    const queued=await rows('outbox');
    for(const command of [...queued.filter(x=>x.state!=='acknowledged'),{path,body}])for(const line of withdrawals(command)){const remaining=(balances.get(line.key)||0n)-line.quantity;if(line.quantity<=0n||remaining<0n)throw Error('الكمية تتجاوز الرصيد المنزّل بعد حجز عمليات الجهاز؛ يلزم اتصال ومراجعة المخزون');balances.set(line.key,remaining);}
   }catch(e){return error(e.message,409);}
   await put('outbox',{id:body.operationId,path,body,signature:account.offlineSignature,state:'pending',createdAt:new Date().toISOString()});
  }
  await render();window.dispatchEvent(new CustomEvent('almahasib:erp-pending',{detail:{path,id:body.operationId}}));
  return json({pending:true,operationId:body.operationId,result:{status:'pending',operationId:body.operationId}},202,true);
 }
 async function transport(input,options={}){
  const mutation=!['GET','HEAD','OPTIONS'].includes(String(options.method||'GET').toUpperCase());
  if(mutation&&usingLan&&lan?.url&&valid()){
   const url=new URL(typeof input==='string'?input:input.url,location.href),headers=new Headers(options.headers||{});headers.set('Authorization','Bearer '+lan.token);
   return rawFetch(lan.url+url.pathname+url.search,{...options,headers,credentials:'omit',signal:options.signal||AbortSignal.timeout(3000)});
  }
  try{const r=await rawFetch(input,{...options,signal:options.signal||AbortSignal.timeout(3000)});if(r.status<500){usingLan=false;return r;}}catch(e){if(options.signal?.aborted)throw e;}
  // A lost response may follow a committed write. Never replay it on another database.
  if(mutation)throw Error('لم يُؤكد استلام العملية؛ بقيت محفوظة للمراجعة وإعادة المحاولة');
  if(lan?.url&&valid()){
   const url=new URL(typeof input==='string'?input:input.url,location.href);
   const headers=new Headers(options.headers||{});headers.set('Authorization','Bearer '+lan.token);
   const response=await rawFetch(lan.url+url.pathname+url.search,{...options,headers,credentials:'omit',signal:options.signal||AbortSignal.timeout(3000)});usingLan=true;return response;
  }
  throw Error('الخادم غير متاح؛ البيانات محفوظة على الجهاز');
 }
 window.fetch=async function(input,options={}){
  const url=new URL(typeof input==='string'?input:input.url,location.href),method=String(options.method||input?.method||'GET').toUpperCase();
  if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return rawFetch(input,options);
  await ready;
  if(method==='POST'&&routes.has(url.pathname)&&valid()){
   const saved=await queue(url.pathname,JSON.parse(options.body||'{}'));if(saved.status===202)void synchronize();return saved;
  }
  if(method==='GET'&&valid()&&readPaths.has(url.pathname)){
   const cached=url.pathname==='/api/v1/bootstrap'?{data:account,signature:account.offlineSignature}:await read(db.transaction('reads').objectStore('reads').get(url.pathname+url.search));
   if(cached?.signature===account.offlineSignature)return json(cached.data,200,true);
  }
  try{
   const response=await transport(input,options);
   reachable=true;
   if(url.pathname==='/api/v1/auth/login'&&response.ok){reset();reachable=true;}
   if(url.pathname==='/api/v1/auth/logout'&&response.ok)reset();
   if(response.status===401&&url.pathname!=='/api/v1/auth/login'){reset();void render();return response;}
   if(response.ok&&method==='GET'&&readPaths.has(url.pathname)){
    const data=await response.clone().json();
    if(url.pathname==='/api/v1/bootstrap')await open(data);
    if(url.pathname==='/api/local/status')localServer=data.local===true;
    if(db&&valid())await put('reads',{path:url.pathname+url.search,data,savedAt:new Date().toISOString(),signature:account.offlineSignature});
   }
   void render();return response;
  }catch(e){
   if(options.signal?.aborted)throw e;
   reachable=false;void render();
   if(!valid())throw e;
   if(method==='GET'&&readPaths.has(url.pathname)){
    if(url.pathname==='/api/v1/bootstrap')return json(account,200,true);
    const cached=await read(db.transaction('reads').objectStore('reads').get(url.pathname+url.search));
    if(cached?.signature===account.offlineSignature)return json(cached.data,200,true);
    return error('لم تُنزّل بيانات هذه الصفحة على هذا الجهاز. افتحها مرة مع الاتصال أولًا');
   }
   if(method==='GET'&&url.pathname==='/api/v1/presence/online-users')return json({count:0,userIds:[]},200,true);
   if(method==='POST'&&routes.has(url.pathname))return queue(url.pathname,JSON.parse(options.body||'{}'));
   if(method==='POST'&&url.pathname==='/api/v1/auth/logout'){reset();return json({ok:true});}
   if(method!=='GET')return error('هذه العملية تحتاج اتصالًا واعتمادًا من الخادم؛ لم تُرسل ولم تُحفظ كعملية معتمدة');
   throw e;
  }
 };
 function synchronize(){if(flushPromise)return flushPromise;const run=()=>flush();flushPromise=(navigator.locks?navigator.locks.request('erp-sync-'+account?.company.id+'-'+account?.user.id,run):run()).finally(()=>{flushPromise=null;});return flushPromise;}
 async function flush(){
  await ready;if(!valid()||flushing)return;flushing=true;
  try{
   const auth=await transport('/api/v1/bootstrap',{credentials:'same-origin'});
   if(auth.status===401){reset();return;}if(!auth.ok)throw Error('تعذر التحقق من الجلسة');
   const fresh=await auth.json();if(fresh.company.id!==account.company.id||fresh.user.id!==account.user.id)throw Error('تغير الحساب؛ سجّل الدخول قبل مزامنة العمليات');
   await open(fresh);reachable=true;
   try{const local=await transport('/api/local/status');if(local.ok)localServer=(await local.json()).local===true;
    if(localServer){const response=await transport('/api/local/cloud/status',{credentials:'same-origin'});if(response.ok)cloud=await response.json();}
   }catch{}
   const all=await rows('outbox');if(all.some(x=>x.state==='conflict'))return;
   const pending=all.filter(x=>['pending','sending'].includes(x.state)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
   for(const row of pending){
    if(row.signature&&row.signature!==account.offlineSignature)break;
    row.state='sending';await put('outbox',row);
    const response=await transport(row.path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(row.body)});
    const result=await response.json();
    if(response.status===401){row.state='pending';await put('outbox',row);reset();break;}
    if(response.status>=500){row.state='pending';await put('outbox',row);break;}
    const rejected=!response.ok||result.result?.status==='rejected';
    row.state=rejected?'conflict':'acknowledged';row.result=result;row.completedAt=new Date().toISOString();await put('outbox',row);
    if(rejected)break;
   }
   for(const path of readPaths){if(path==='/api/v1/bootstrap')continue;try{const response=await transport(path,{credentials:'same-origin'});if(response.ok)await put('reads',{path,data:await response.json(),savedAt:new Date().toISOString(),signature:account.offlineSignature});}catch{break;}}
   window.dispatchEvent(new CustomEvent('almahasib:erp-synced'));
  }catch{reachable=false;}finally{flushing=false;await render();}
 }
 async function review(){
  const list=await rows('outbox'),dialog=document.createElement('dialog'),title=document.createElement('h3');title.textContent='عمليات هذا الجهاز — الاعتماد على الخادم فقط';dialog.append(title);
  for(const row of list.filter(x=>x.state!=='acknowledged')){const p=document.createElement('p');p.textContent=row.path+' · '+row.state+' · '+(row.result?.error?.message||row.result?.result?.error?.message||row.createdAt);dialog.append(p);}
  const exportButton=document.createElement('button');exportButton.textContent='تصدير العمليات للمراجعة';exportButton.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(list,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='ERP-pending-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};dialog.append(exportButton);
  const close=document.createElement('button');close.textContent='إغلاق';close.onclick=()=>dialog.close();dialog.append(close);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
 }
 async function configureLAN(){
  if(!valid())return;
  const dialog=document.createElement('dialog'),form=document.createElement('form'),fields={};
  dialog.style.cssText='width:min(520px,90vw);max-height:85vh;overflow:auto;padding:24px;direction:rtl';
  form.style.cssText='display:flex;flex-direction:column;gap:12px;position:static';
  for(const [key,label,value,type] of [['url','عنوان خادم الفرع HTTPS',lan?.url||'','url'],['companyCode','رمز الشركة',account.company.code||'','text'],['username','حسابك على خادم الفرع',account.user.username||'','text'],['password','كلمة مرور حساب الفرع','','password']]){const l=document.createElement('label'),input=document.createElement('input');l.textContent=label;input.type=type;input.value=value;input.required=true;input.style.cssText='display:block;margin:8px 0;padding:10px;';l.append(input);form.append(l);fields[key]=input;}
  const note=document.createElement('p');note.textContent='اربط خادم الفرع بالشركة السحابية أولًا. يجب أن تكون شهادة HTTPS موثوقة وأن يسمح الخادم بعنوان هذا التطبيق.';form.append(note);
  const save=document.createElement('button');save.textContent='تحقق واحفظ';const close=document.createElement('button');close.type='button';close.textContent='إلغاء';close.onclick=()=>dialog.close();form.append(save,close);dialog.append(form);document.body.append(dialog);dialog.onclose=()=>dialog.remove();
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{
   const url=new URL(fields.url.value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('أدخل أصل خادم HTTPS فقط، دون مسار أو بيانات دخول');
   const r=await rawFetch(url.origin+'/api/v1/auth/login',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:fields.companyCode.value,username:fields.username.value,password:fields.password.value}),signal:AbortSignal.timeout(8000)}),login=await r.json();if(!r.ok)throw Error(login.error?.message||'تعذر دخول خادم الفرع');
   const bootstrap=await rawFetch(url.origin+'/api/v1/bootstrap',{headers:{Authorization:'Bearer '+login.token},signal:AbortSignal.timeout(8000)}),identity=await bootstrap.json();if(!bootstrap.ok||identity.company?.id!==account.company.id||identity.user?.id!==account.user.id)throw Error('خادم الفرع لا يطابق شركتك وحسابك؛ اربطه بالسحابة قبل استخدامه');
   lan={url:url.origin,token:login.token};await put('reads',{path:'@lan',data:lan});dialog.close();void synchronize();
  }catch(e){note.textContent=e.message;}finally{save.disabled=false;}};dialog.showModal();
 }
 window.AlMahasibERP={status,synchronize,review,connectionText,configureLAN};
 document.addEventListener('DOMContentLoaded',()=>{
  const launcher=document.createElement('button');launcher.type='button';launcher.textContent='⇄';launcher.title='الاتصال والمزامنة';launcher.setAttribute('aria-label','الاتصال والمزامنة');launcher.style.cssText='position:fixed;bottom:18px;left:18px;z-index:50;width:42px;height:42px;border-radius:50%;border:1px solid #dce5eb;background:#fff;color:#126b65;padding:0;box-shadow:0 4px 16px #102a4320';
  const panel=document.createElement('dialog');panel.style.cssText='padding:24px;direction:rtl;width:min(480px,90vw);max-height:80vh;overflow:auto;border:1px solid #dce5eb;border-radius:18px;background:white;color:#163c39';
  launcher.id='erpConnectionButton';launcher.hidden=!valid();launcher.onclick=()=>panel.showModal();document.body.append(launcher);
  const text=document.createElement('span');text.id='erpOfflineStatus';panel.append(text);
  for(const [label,action] of [['مزامنة الجهاز',synchronize],['العمليات المحفوظة',()=>{panel.close();return review();}],['خادم الشبكة المحلية',()=>{panel.close();return configureLAN();}],['إغلاق',()=>panel.close()]]){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void action();b.style.cssText='display:block;margin-top:12px;width:100%';panel.append(b);}document.body.append(panel);void render();
  if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('/erp-service-worker.js',{scope:'/'}).catch(()=>{text.textContent+=' · تعذر تجهيز الصفحات دون اتصال';});
  else{text.textContent='التشغيل دون اتصال على الهاتف يحتاج HTTPS أو localhost';}
  void (async()=>{try{await window.fetch('/api/v1/bootstrap',{credentials:'same-origin'});}catch{}await synchronize();})();
 });
 window.addEventListener('online',()=>void synchronize());window.addEventListener('offline',()=>{reachable=false;void render();});setInterval(()=>void synchronize(),60000);
})();
