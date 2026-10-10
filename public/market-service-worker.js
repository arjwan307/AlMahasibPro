const CACHE='almahasib-market-shell-v2';
const SHELL=['/app-ui.css?v=1.2.0','/app-ui.js?v=1.2.0','/market-cashier.html','/market-offline.js?v=cashier-offline-16','/market-cashier-ledger.js?v=cashier-offline-16','/pos-ui.js?v=cashier-offline-16','/scanner-qrcode.js','/market-trial-catalog.json'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('almahasib-market-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim()})()));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response.ok&&new URL(request.url).origin===self.location.origin){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy))}
    return response;
  }).catch(()=>request.mode==='navigate'?caches.match('/market-cashier.html'):new Response('',{status:503}))));
});
