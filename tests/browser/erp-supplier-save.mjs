// Run with Playwright available, optionally setting PLAYWRIGHT_MODULE_PATH and
// CHROMIUM_EXECUTABLE_PATH. Exercises the real browser scripts against an API fixture.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const require=createRequire(process.env.PLAYWRIGHT_MODULE_PATH||new URL('../../package.json',import.meta.url));
const {chromium}=require('playwright');
const root=process.env.ERP_SOURCE_DIR||fileURLToPath(new URL('../../public/',import.meta.url));
const supplierFields={code:'SUP-TEST-1',name:'مورد اختبار الحفظ',country:'العراق',companyName:'شركة الاختبار',specialty:'تجهيزات',relationshipStartYear:'2026',phone:'07701234567'};
const account={company:{id:randomUUID(),code:'supplier-test',legalName:'شركة اختبار الموردين',currency:'IQD'},user:{id:randomUUID(),username:'admin',displayName:'مدير'},roles:[],scopes:[],permissions:['suppliers.read','suppliers.manage','sync.use'],offlineSessionExpiresAt:new Date(Date.now()+86400000).toISOString()};
const suppliers=[];
let rejected=false,masterReads=0,masterGate=null;
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/api/local/status')return json(res,200,{local:false});
  if(path==='/api/v1/bootstrap')return json(res,200,account);
  if(path==='/api/v1/company/deletion-notice')return json(res,200,{deleted:false});
  if(path==='/api/v1/master-data'){
   masterReads++;
   if(masterGate){const gate=masterGate;masterGate=null;gate.started();await gate.promise;}
   return json(res,200,{suppliers:structuredClone(suppliers),customers:[],items:[],units:[],warehouses:[],prices:[],stock:[]});
  }
  if(path==='/api/v1/suppliers'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;
   const input=JSON.parse(body);
   if(rejected)return json(res,409,{error:{message:'رمز المورد مستخدم'}});
   const supplier={...input,id:randomUUID()};suppliers.push(supplier);
   return json(res,201,{supplier});
  }
  if(path.startsWith('/api/'))return json(res,404,{error:{message:'مسار غير مستخدم في الاختبار'}});
  const filename=join(root,path.slice(1)),content=await readFile(filename);
  res.writeHead(200,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html'});res.end(content);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 const context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/enterprise.html');
 await page.waitForFunction(()=>window.AlMahasibOutput?.().account&&!document.getElementById('workspace').hidden);
 await page.waitForFunction(()=>navigator.serviceWorker.controller);
 // Finish the initial cache download before reproducing save against a cached list.
 await page.evaluate(()=>AlMahasibERP.synchronize());
 await page.locator('nav [data-view="suppliers"]').click();
 for(const [name,value] of Object.entries(supplierFields))await page.locator('#editor [name="'+name+'"]').fill(value);
 await page.locator('#editor button').click();
 await page.waitForFunction(()=>document.querySelector('.supplier-card h3')?.textContent==='مورد اختبار الحفظ',{},{timeout:5000});
 assert.equal(suppliers.length,1,'The API creates exactly one supplier');
 assert.deepEqual(suppliers[0],{...supplierFields,id:suppliers[0].id});
 assert.equal(await page.locator('#editor [name="name"]').inputValue(),'','Clear fields after confirmed save');
 console.log('PASS: saved supplier immediately appears despite an existing cached list');

 await page.reload();
 await page.waitForFunction(()=>window.AlMahasibOutput?.().account&&!document.getElementById('workspace').hidden);
 await page.locator('nav [data-view="suppliers"]').click();
 assert.equal(await page.locator('.supplier-card h3').textContent(),supplierFields.name);
 console.log('PASS: supplier remains visible after reloading');

 await page.locator('#editor [name="name"]').fill('مسودة المورد التالي');
 const before=masterReads;
 await page.evaluate(async()=>{
  window.dispatchEvent(new CustomEvent('almahasib:erp-synced'));
  await AlMahasibOutput().refresh({background:true});
 });
 assert.equal(await page.locator('#editor [name="name"]').inputValue(),'مسودة المورد التالي');
 assert.equal(masterReads,before,'Background refresh defers while the supplier draft is active');
 console.log('PASS: automatic synchronization keeps unsaved supplier fields');

 await page.evaluate(()=>document.getElementById('editor').reset());
 let release,started;
 const start=new Promise(resolve=>started=resolve);
 masterGate={started,promise:new Promise(resolve=>release=resolve)};
 const refresh=page.evaluate(()=>AlMahasibOutput().refresh({background:true}));
 await start;
 await page.locator('#editor [name="name"]').fill('كتابة أثناء التحديث');
 release();await refresh;
 assert.equal(await page.locator('#editor [name="name"]').inputValue(),'كتابة أثناء التحديث');
 console.log('PASS: typing during an in-flight refresh is preserved');

 rejected=true;
 for(const [name,value] of Object.entries(supplierFields))await page.locator('#editor [name="'+name+'"]').fill(value);
 await page.locator('#editor button').click();
 await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('رمز المورد مستخدم'));
 for(const [name,value] of Object.entries(supplierFields))assert.equal(await page.locator('#editor [name="'+name+'"]').inputValue(),value);
 assert.equal(suppliers.length,1);
 console.log('PASS: a rejected save shows the error and preserves every field');

 // The network-first master read must still retain the offline fallback.
 await context.setOffline(true);
 const offline=await page.evaluate(async()=>{const response=await fetch('/api/v1/master-data');return{status:response.status,offline:response.headers.get('X-AlMahasib-Offline'),data:await response.json()};});
 assert.equal(offline.status,200);assert.equal(offline.offline,'true');
 assert.equal(offline.data.suppliers[0].name,supplierFields.name);
 console.log('PASS: the updated supplier list remains available without a connection');
 assert.deepEqual(errors,[]);
}finally{
 await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
