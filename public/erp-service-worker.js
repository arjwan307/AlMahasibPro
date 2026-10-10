importScripts('/erp-shell-manifest.js');
const CACHE='almahasib-erp-shell-1.2.5';
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 await Promise.allSettled(self.ERP_SHELL.map(async path=>{const r=await fetch(path,{cache:'reload',signal:AbortSignal.timeout(8000)});if(r.ok)await cache.put(path,r);}));
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys())if((name.startsWith('almahasib-erp-shell-')||name.startsWith('almahasib-market-shell-'))&&name!==CACHE)await caches.delete(name);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(!self.ERP_SHELL.includes(url.pathname)&&url.pathname!=='/')return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),path=url.pathname==='/'?'/index.html':url.pathname;
  if(request.mode==='navigate'){
   const page=await cache.match(path);if(page)return page;
   try{const response=await fetch(request,{signal:AbortSignal.timeout(5000)});if(response.ok)await cache.put(path,response.clone());return response;}catch{return new Response('افتح هذه الصفحة مرة مع الاتصال لتجهيز العمل دون إنترنت',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}
  }
  const cached=await cache.match(path);if(cached)return cached;
  const response=await fetch(request);if(response.ok)await cache.put(path,response.clone());return response;
 })());
});

