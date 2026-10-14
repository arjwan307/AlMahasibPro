importScripts('/erp-shell-manifest.js');
const PRODUCT=new URL(self.registration.scope).pathname.startsWith('/retail/')?'retail':'company';
const PREFIX='almahasib-erp-shell-'+PRODUCT+'-';
const CACHE=PREFIX+(PRODUCT==='company'?'1.2.23-offline-sales-statements':'1.2.7-logistics-v6');
// Cached redirected responses cannot satisfy Chromium navigation requests.
// Preserve their content while removing the redirected response metadata.
const shellResponse=response=>response.redirected?new Response(response.clone().body,{status:response.status,statusText:response.statusText,headers:response.headers}):response;
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 // A worker must never become active with an incomplete company shell.
 // Cache the essential company UI first; optional pages cannot block an update.
 const essential=['/index.html','/login.html','/enterprise.html','/enterprise.js','/enterprise.css','/erp-offline.js','/company-runtime-ui.js','/company-sync-ui.js','/sales-workspace.js','/sales-workspace.css','/logistics-workspace.js','/logistics-workspace.css'];
 // The cloud redirects /index.html to login; it is not a required asset.
 const companyAssets=['/assistant-workbench.js','/assistant.js','/assistant.css','/password-visibility.js','/company-output.js','/company-output.css','/company-messages.js','/company-responsive.js','/company-responsive.css','/app-ui.css','/enterprise-sections.css','/enterprise-workspaces.css'];
 const required=(PRODUCT==='company'?[...essential.filter(path=>path!=='/index.html'),...companyAssets]:essential).filter(path=>self.ERP_SHELL.includes(path));
 for(const path of required){
  const response=await fetch(path,{cache:'reload',signal:AbortSignal.timeout(15000)});
  if(!response.ok||response.redirected)throw Error('Offline shell asset unavailable: '+path);
  await cache.put(path,response);
 }
 const optional=self.ERP_SHELL.filter(path=>!required.includes(path));
 for(let i=0;i<optional.length;i+=4){
  await Promise.allSettled(optional.slice(i,i+4).map(async path=>{
   const response=await fetch(path,{cache:'reload',signal:AbortSignal.timeout(8000)});
   if(response.ok&&!response.redirected)await cache.put(path,response);
  }));
 }
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if((name.startsWith(PREFIX)||PRODUCT==='company'&&/^almahasib-erp-shell-\d/.test(name))&&name!==CACHE)await caches.delete(name);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 const companyEntry=PRODUCT==='company'&&['/','/index.html','/companies','/companies/'].includes(url.pathname);
 if(!self.ERP_SHELL.includes(url.pathname)&&url.pathname!=='/'&&!companyEntry)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),path=url.pathname==='/'?'/index.html':url.pathname;
  if(request.mode==='navigate'){
   // Keep the online landing redirect; offline entry must use the prepared ERP.
   if(companyEntry){
    try{return shellResponse(await fetch(request,{signal:AbortSignal.timeout(5000)}));}
    catch{const entry=await cache.match('/enterprise.html');if(entry)return shellResponse(entry);}
   }
   const page=await cache.match(path);if(page)return shellResponse(page);
   try{const response=await fetch(request,{signal:AbortSignal.timeout(5000)});if(response.ok)await cache.put(path,shellResponse(response).clone());return shellResponse(response);}catch{return new Response('افتح هذه الصفحة مرة مع الاتصال لتجهيز العمل دون إنترنت',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
  }
  const cached=await cache.match(path);if(cached)return cached;
  const response=await fetch(request);if(response.ok)await cache.put(path,response.clone());return response;
 })());
});

