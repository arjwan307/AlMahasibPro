import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('cached redirected shell pages are safe for Chromium navigation and keep content',async()=>{
 const listeners={};
 const cached=new Response('<main>login page</main>',{headers:{'Content-Type':'text/html'}});
 Object.defineProperty(cached,'redirected',{value:true});
 const context={Response,URL,AbortSignal,importScripts(){},self:{registration:{scope:'https://example.test/'},ERP_SHELL:['/index.html','/dashboard.html'],location:{origin:'https://example.test'},addEventListener(name,fn){listeners[name]=fn;}},caches:{open:async()=>({match:async()=>cached})}};
 runInNewContext(readFileSync(new URL('../../public/erp-service-worker.js',import.meta.url),'utf8'),context);
 let response;
 listeners.fetch({request:{url:'https://example.test/index.html',method:'GET',mode:'navigate'},respondWith(value){response=value;}});
 const safe=await response;
 assert.equal(safe.redirected,false);
 assert.equal(safe.status,200);
 assert.equal(safe.headers.get('Content-Type'),'text/html');
 assert.equal(await safe.text(),'<main>login page</main>');
});

test('installation refuses to activate an incomplete offline company shell',async()=>{
 const listeners={},written=[],installed=[];
 const origin='https://example.test';
 const context={
  Response,URL,AbortSignal,
  importScripts(){},
  self:{
   registration:{scope:origin+'/'},
   ERP_SHELL:['/index.html','/login.html','/enterprise.html','/enterprise.js','/enterprise.css','/erp-offline.js','/company-runtime-ui.js','/company-sync-ui.js','/sales-workspace.js','/sales-workspace.css','/logistics-workspace.js','/logistics-workspace.css'],
   location:{origin},
   addEventListener(name,fn){listeners[name]=fn;},
   async skipWaiting(){installed.push(true);}
  },
  caches:{open:async()=>({put:async(path)=>{written.push(path);}})},
  fetch:async path=>new Response('body',{status:path==='/enterprise.html'?503:200})
 };
 runInNewContext(readFileSync(new URL('../../public/erp-service-worker.js',import.meta.url),'utf8'),context);
 let installation;
 listeners.install({waitUntil(promise){installation=promise;}});
 await assert.rejects(installation,/Offline shell asset unavailable: \/enterprise.html/);
 assert.equal(installed.length,0);
 assert.equal(written.includes('/enterprise.html'),false);
});

 test('company shell activates when the cloud index redirects, but requires all enterprise assets',async()=>{
 const listeners={},written=[],installed=[];
 const html=readFileSync(new URL('../../public/enterprise.html',import.meta.url),'utf8');
 const assets=[...html.matchAll(/(?:src|href)="(\/[^"?]+)(?:[^" ]*)"/g)].map(x=>x[1]);
 const context={Response,URL,AbortSignal,importScripts(){},self:{registration:{scope:'https://example.test/'},ERP_SHELL:[...new Set(['/index.html','/login.html','/enterprise.html',...assets])],location:{origin:'https://example.test'},addEventListener(n,f){listeners[n]=f;},async skipWaiting(){installed.push(true);}},caches:{open:async()=>({put:async p=>written.push(p)})},fetch:async p=>{const r=new Response('asset');if(p==='/index.html')Object.defineProperty(r,'redirected',{value:true});return r;}};
 runInNewContext(readFileSync(new URL('../../public/erp-service-worker.js',import.meta.url),'utf8'),context);
 let installation;listeners.install({waitUntil(p){installation=p;}});await installation;
 assert.equal(installed.length,1);assert.equal(written.includes('/index.html'),false);
 for(const asset of assets)assert(written.includes(asset),asset);
 });

for(const path of ['/', '/index.html', '/companies', '/companies/'])test('offline company entry opens cached enterprise: '+path,async()=>{
 const listeners={},lookups=[];
 const context={Response,URL,AbortSignal,importScripts(){},self:{registration:{scope:'https://example.test/'},ERP_SHELL:['/index.html','/enterprise.html'],location:{origin:'https://example.test'},addEventListener(n,f){listeners[n]=f;}},caches:{open:async()=>({match:async p=>{lookups.push(p);return p==='/enterprise.html'?new Response('<main>ERP</main>',{headers:{'Content-Type':'text/html'}}):undefined;}})},fetch:async()=>{throw Error('offline');}};
 runInNewContext(readFileSync(new URL('../../public/erp-service-worker.js',import.meta.url),'utf8'),context);
 let response;listeners.fetch({request:{url:'https://example.test'+path,method:'GET',mode:'navigate'},respondWith(p){response=p;}});
 const result=await response;assert.equal(result.status,200);assert.equal(await result.text(),'<main>ERP</main>');assert.deepEqual(lookups,['/enterprise.html']);
});

test('online company root keeps the server landing response',async()=>{
 const listeners={};const context={Response,URL,AbortSignal,importScripts(){},self:{registration:{scope:'https://example.test/'},ERP_SHELL:['/index.html','/enterprise.html'],location:{origin:'https://example.test'},addEventListener(n,f){listeners[n]=f;}},caches:{open:async()=>({match:async()=>{throw Error('Online entry must use server');}})},fetch:async()=>new Response('<main>online login</main>')};
 runInNewContext(readFileSync(new URL('../../public/erp-service-worker.js',import.meta.url),'utf8'),context);let response;listeners.fetch({request:{url:'https://example.test/',method:'GET',mode:'navigate'},respondWith(p){response=p;}});assert.equal(await (await response).text(),'<main>online login</main>');
});
