importScripts('/erp-shell-manifest.js');
const PRODUCT=new URL(self.registration.scope).pathname.startsWith('/retail/')?'retail':'company';
const PREFIX='almahasib-erp-shell-'+PRODUCT+'-';
const CACHE=PREFIX+(PRODUCT==='company'?'1.2.17-assistant-workbench-r1':'1.2.7-logistics-v6');
// Cached redirected responses cannot satisfy Chromium navigation requests.
// Preserve their content while removing the redirected response metadata.
const shellResponse=response=>response.redirected?new Response(response.clone().body,{status:response.status,statusText:response.statusText,headers:response.headers}):response;
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 await Promise.allSettled(self.ERP_SHELL.map(async path=>{const r=await fetch(path,{cache:'reload',signal:AbortSignal.timeout(8000)});if(r.ok)await cache.put(path,r);}));
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if((name.startsWith(PREFIX)||PRODUCT==='company'&&/^almahasib-erp-shell-\d/.test(name))&&name!==CACHE)await caches.delete(name);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(!self.ERP_SHELL.includes(url.pathname)&&url.pathname!=='/')return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),path=url.pathname==='/'?'/index.html':url.pathname;
  if(request.mode==='navigate'){
   const page=await cache.match(path);if(page)return shellResponse(page);
   try{const response=await fetch(request,{signal:AbortSignal.timeout(5000)});if(response.ok)await cache.put(path,shellResponse(response).clone());return shellResponse(response);}catch{return new Response('افتح هذه الصفحة مرة مع الاتصال لتجهيز العمل دون إنترنت',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
  }
  const cached=await cache.match(path);if(cached)return cached;
  const response=await fetch(request);if(response.ok)await cache.put(path,response.clone());return response;
 })());
});

