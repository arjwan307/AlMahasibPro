import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('cached redirected shell pages are safe for Chromium navigation and keep content',async()=>{
 const listeners={};
 const cached=new Response('<main>login page</main>',{headers:{'Content-Type':'text/html'}});
 Object.defineProperty(cached,'redirected',{value:true});
 const context={Response,URL,AbortSignal,importScripts(){},self:{ERP_SHELL:['/index.html','/dashboard.html'],location:{origin:'https://example.test'},addEventListener(name,fn){listeners[name]=fn;}},caches:{open:async()=>({match:async()=>cached})}};
 runInNewContext(readFileSync(new URL('../../public/erp-service-worker.js',import.meta.url),'utf8'),context);
 let response;
 listeners.fetch({request:{url:'https://example.test/index.html',method:'GET',mode:'navigate'},respondWith(value){response=value;}});
 const safe=await response;
 assert.equal(safe.redirected,false);
 assert.equal(safe.status,200);
 assert.equal(safe.headers.get('Content-Type'),'text/html');
 assert.equal(await safe.text(),'<main>login page</main>');
});
