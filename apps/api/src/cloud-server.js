import { startBackupService } from './lib/backup-service.js';
import { resetInstallationOnce } from './lib/clean-install.js';
import { productPages } from './product-pages.js';
import express from 'express';
import { join } from 'node:path';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createApp } from './app.js';
import { SQLiteStore } from './store/sqlite-store.js';
import { hashPassword } from './lib/security.js';
import { normalizeUsername } from './lib/http.js';

async function createProductCloud({ dataDirectory, setupToken, origin, product = 'company', basePath = '', sharedStore = null }) {
 if (!dataDirectory || !origin) throw Error('ALMAHASIB_DATA_DIR and ALMAHASIB_PUBLIC_ORIGIN are required');
 origin = new URL(origin).origin;
 await mkdir(dataDirectory, {recursive:true});
 const store=sharedStore||new SQLiteStore(join(dataDirectory,'enterprise.sqlite'));
 // Bootstrap the first platform administrator only when the Render service owner
 // explicitly supplies credentials. Never reset or replace an existing admin.
 if(product==='company'&&process.env.PLATFORM_ADMIN_USERNAME&&process.env.PLATFORM_ADMIN_PASSWORD){
  const admins=await store.listPlatformAdmins();
  if(admins.length===0){
   await store.seedPlatformAdmin({
    username:normalizeUsername(process.env.PLATFORM_ADMIN_USERNAME),
    displayName:String(process.env.PLATFORM_ADMIN_NAME||'مدير المنصة').trim().slice(0,120),
    passwordHash:await hashPassword(process.env.PLATFORM_ADMIN_PASSWORD)
   });
  }
 }
 const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
 app.use((req,res,next)=>{if(req.headers.origin && req.headers.origin!==origin)return res.status(403).json({error:{message:'المصدر غير مسموح'}});next();});
 app.use((req,res,next)=>{if(product==='company'&&!req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next();});
 const defaultJsonParser=express.json({limit:'5mb',verify(req,res,bytes){if(req.path==='/api/v1/notifications/webhook')req.rawBody=Buffer.from(bytes);}});const assistantChatJsonParser=express.json({limit:'21mb'});
 app.use((req,res,next)=>(req.path==='/api/v1/assistant/chat'?assistantChatJsonParser:defaultJsonParser)(req,res,next));
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
 app.get('/api/health',(_req,res)=>res.json({ok:true,storage:'sqlite',service:'AlMahasibPro'}));
 const belongsToProduct=company=>(company.product||'company')===product;
 const productCompany=()=>[...store.companies.values()].find(belongsToProduct);
 app.get('/api/local/status',(_req,res)=>{const company=productCompany();res.json({local:false,initialized:Boolean(company),setupRequired:!company,companyCode:company?.code,generation:store.installationGeneration||null});});
 let configuring=false;
 app.post('/api/local/setup',async(req,res)=>{
  if(productCompany()||configuring)return res.status(409).json({error:{message:'تم إعداد المنشأة سابقًا'}});
  const hash=value=>createHash('sha256').update(String(value||'')).digest();
  if(!setupToken||setupToken.length<24||!timingSafeEqual(hash(setupToken),hash(req.body.setupToken)))return res.status(403).json({error:{message:'مفتاح إعداد الخادم غير صحيح'}});
  configuring=true;
  try{
   const {legalName,ownerName,username,password}=req.body;
   if(typeof legalName!=='string'||typeof ownerName!=='string'||!legalName.trim()||!ownerName.trim()||typeof password!=='string'||password.length<10)throw Error('أكمل البيانات وكلمة مرور عشرة أحرف على الأقل');
   const company=await store.registerCompany({code:product==='retail'?'retail':'company',product,legalName:legalName.trim(),timezone:'Asia/Baghdad',currency:'IQD',owner:{username:normalizeUsername(username),displayName:ownerName.trim(),passwordHash:await hashPassword(password)}});
   await store.approveCompany(company.id,company.ownerUserId);res.status(201).json({companyCode:company.code});
  }catch(error){res.status(400).json({error:{message:error.message}});}finally{configuring=false;}
 });
 app.use((req,_res,next)=>{if(req.method==='POST'&&req.path==='/api/v1/companies/register')req.productScope=req.body.product==='retail'||product==='retail'?'retail':'company';next();});
 const api=createApp({store,notificationSending:product==='company',secureCookies:origin.startsWith('https:'),allowedOrigins:[origin],cookieName:'almahasib_session',cookiePath:'/'});app.use(api);
 return {app,store,stopNotifications:()=>api.stopNotifications?.()};
}

export async function startEnterpriseCloud({ dataDirectory, setupToken, origin, port = 10000, host = '0.0.0.0', resetGeneration = process.env.ALMAHASIB_RESET_COMPANIES_ONCE }) {
 const store=new SQLiteStore(join(dataDirectory,'enterprise.sqlite'));
 const legacyRetailFile=join(dataDirectory,'retail','enterprise.sqlite');
 try{await access(legacyRetailFile);const legacyRetail=new SQLiteStore(legacyRetailFile);try{await store.mergeFrom(legacyRetail,'retail');}finally{await legacyRetail.close();}}catch(error){if(error.code!=='ENOENT')throw error;}
 if(await resetInstallationOnce(store,dataDirectory,resetGeneration))console.log('AlMahasibPro clean installation completed: company data cleared; platform administrators preserved.');
 const backups=startBackupService({store,directory:process.env.ALMAHASIB_BACKUP_DIR||join(dataDirectory,'backups')});store.backupService=backups;
 const company=await createProductCloud({dataDirectory,setupToken,origin,sharedStore:store});
 const retail=await createProductCloud({dataDirectory,setupToken,origin,sharedStore:store,product:'retail',basePath:'/retail'});
 const app=express();app.set('trust proxy',1);
 app.get(['/', '/index.html'],(_req,res)=>res.redirect('/login.html'));
 app.get('/companies',(_req,res)=>res.redirect('/enterprise.html'));
 app.get('/companies/',(_req,res)=>res.redirect('/enterprise.html'));
 app.get('/restaurants',(_req,res)=>res.redirect('/retail/retail-login.html'));
 app.get('/restaurants/',(_req,res)=>res.redirect('/retail/retail-login.html'));
 app.use('/retail',retail.app);
 app.use(company.app);
 const server=await new Promise((resolve,reject)=>{const server=app.listen(port,host,()=>resolve(server));server.on('error',reject);});
 return {store:company.store,retailStore:retail.store,url:`http://127.0.0.1:${server.address().port}`,close:async()=>{company.stopNotifications();retail.stopNotifications();await backups.close();await new Promise(resolve=>server.close(resolve));await company.store.close();}};
}
if(process.argv[1]?.endsWith('cloud-server.js')){
 const runtime=await startEnterpriseCloud({dataDirectory:process.env.ALMAHASIB_DATA_DIR,setupToken:process.env.ALMAHASIB_SETUP_TOKEN,origin:process.env.ALMAHASIB_PUBLIC_ORIGIN,port:Number(process.env.PORT||10000)});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>runtime.close().then(()=>process.exit(0)));
}
