import { furnitureCatalog } from './furniture-catalog.js';
import { productPages } from './product-pages.js';
import express from 'express';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createApp } from './app.js';
import { SQLiteStore } from './store/sqlite-store.js';
import { hashPassword } from './lib/security.js';
import { normalizeUsername } from './lib/http.js';

async function createProductCloud({ dataDirectory, setupToken, origin, product = 'company', basePath = '' }) {
 if (!dataDirectory || !origin) throw Error('ALMAHASIB_DATA_DIR and ALMAHASIB_PUBLIC_ORIGIN are required');
 origin = new URL(origin).origin;
 await mkdir(dataDirectory, {recursive:true});
 const store=new SQLiteStore(join(dataDirectory,'enterprise.sqlite'));
 if(product==='company'){
  const requestPath=join(dataDirectory,'furniture-catalog-request.json');let request;
  try{request=JSON.parse(await readFile(requestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(request){if(request.catalog!=='furniture-v1'||typeof request.companyCode!=='string')throw Error('Invalid furniture catalogue request');const company=[...store.companies.values()].find(x=>x.code===request.companyCode);if(!company)throw Error('Furniture catalogue company not found');const result=await store.importFurnitureCatalog(company.id,company.ownerUserId,furnitureCatalog());await writeFile(join(dataDirectory,'furniture-catalog-result.json'),JSON.stringify(result,null,2));await rename(requestPath,requestPath+'.done');console.log('[furniture-catalog]',JSON.stringify(result));}
 }
 const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
 app.use((req,res,next)=>{if(req.headers.origin && req.headers.origin!==origin)return res.status(403).json({error:{message:'المصدر غير مسموح'}});next();});
 app.use((req,res,next)=>{if(product==='company'&&!req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next();});
 app.use(express.json({limit:'1mb'}));
 if (basePath) {
  app.use((req,res,next)=>{const redirect=res.redirect.bind(res);res.redirect=target=>redirect(basePath+target);next();});
 }
 app.use(productPages(product));
 if (product === 'retail') app.use(async(req,res,next)=>{
  if(req.path.startsWith('/api/'))return next();
  try{
   const name=req.path.slice(1)+(req.path.includes('.')?'':'.html');
   let content=await readFile(fileURLToPath(new URL('../../../public/'+name,import.meta.url)),'utf8');
   if(/\.(html|js|css)$/.test(name)) content=content.replace(/(["'`])\/(?=[A-Za-z]|["'`])/g, '$1'+basePath+'/');
   if(name.endsWith('.html'))content=content.replace('<head>','<head><script src="'+basePath+'/retail-scope.js"></script>');
   res.type(name.endsWith('.html')?'html':name.endsWith('.js')?'js':name.endsWith('.css')?'css':'json').send(content);
  }catch(error){next(error);}
 });
 app.post('/api/v1/companies/register',(_req,res)=>res.status(403).json({error:{message:'إنشاء الشركات غير متاح على خادم الشركة'}}));
 app.get('/api/health',(_req,res)=>res.json({ok:true,storage:'sqlite',service:'AlMahasibPro'}));
 app.get('/api/local/status',(_req,res)=>res.json({local:false,initialized:store.companies.size>0,setupRequired:store.companies.size===0,companyCode:[...store.companies.values()][0]?.code}));
 let configuring=false;
 app.post('/api/local/setup',async(req,res)=>{
  if(store.companies.size||configuring)return res.status(409).json({error:{message:'تم إعداد الشركة سابقًا'}});
  const hash=value=>createHash('sha256').update(String(value||'')).digest();
  if(!setupToken||setupToken.length<24||!timingSafeEqual(hash(setupToken),hash(req.body.setupToken)))return res.status(403).json({error:{message:'مفتاح إعداد الخادم غير صحيح'}});
  configuring=true;
  try{
   const {legalName,ownerName,username,password}=req.body;
   if(typeof legalName!=='string'||typeof ownerName!=='string'||!legalName.trim()||!ownerName.trim()||typeof password!=='string'||password.length<10)throw Error('أكمل البيانات وكلمة مرور عشرة أحرف على الأقل');
   const company=await store.registerCompany({code:'company',legalName:legalName.trim(),timezone:'Asia/Baghdad',currency:'IQD',owner:{username:normalizeUsername(username),displayName:ownerName.trim(),passwordHash:await hashPassword(password)}});
   await store.approveCompany(company.id,company.ownerUserId);res.status(201).json({companyCode:company.code});
  }catch(error){res.status(400).json({error:{message:error.message}});}finally{configuring=false;}
 });
 app.use(createApp({store,secureCookies:origin.startsWith('https:'),allowedOrigins:[origin],cookieName:product==='retail'?'almahasib_retail_session':'almahasib_session',cookiePath:basePath?basePath+'/':'/'}));
 return {app,store};
}

export async function startEnterpriseCloud({ dataDirectory, setupToken, origin, port = 10000, host = '0.0.0.0' }) {
 const company=await createProductCloud({dataDirectory,setupToken,origin});
 const retail=await createProductCloud({dataDirectory:join(dataDirectory,'retail'),setupToken,origin,product:'retail',basePath:'/retail'});
 const app=express();app.set('trust proxy',1);
 app.get('/companies',(_req,res)=>res.redirect('/enterprise.html'));
 app.get('/companies/',(_req,res)=>res.redirect('/enterprise.html'));
 app.get('/restaurants',(_req,res)=>res.redirect('/retail/retail-login.html'));
 app.get('/restaurants/',(_req,res)=>res.redirect('/retail/retail-login.html'));
 app.use('/retail',retail.app);
 app.use(company.app);
 const server=await new Promise((resolve,reject)=>{const server=app.listen(port,host,()=>resolve(server));server.on('error',reject);});
 return {store:company.store,retailStore:retail.store,url:`http://127.0.0.1:${server.address().port}`,close:async()=>{await new Promise(resolve=>server.close(resolve));await company.store.close();await retail.store.close();}};
}
if(process.argv[1]?.endsWith('cloud-server.js')){
 const runtime=await startEnterpriseCloud({dataDirectory:process.env.ALMAHASIB_DATA_DIR,setupToken:process.env.ALMAHASIB_SETUP_TOKEN,origin:process.env.ALMAHASIB_PUBLIC_ORIGIN,port:Number(process.env.PORT||10000)});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>runtime.close().then(()=>process.exit(0)));
}
