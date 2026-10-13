import {createConnectivityProbe} from './connectivity.js';
import { assertSettingsScope, confirmSettingsOperation, settingsBackup } from '../api/src/modules/settings/routes.js';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hashToken, newSessionToken } from '../api/src/lib/security.js';
import { commandPathAllowed } from '../api/src/lib/desktop-sync.js';

const defaultCloud='https://shenoo-menoo-tak-tak.onrender.com';
export async function installLocalCloud(app,{store,dataDirectory,protect,unprotect,allowTestCloud=false,cloudOrigin=defaultCloud,product='company'}){
  const filename=join(dataDirectory,'cloud-connection.json');
  const shutdown=new AbortController();const onlineTimeout=allowTestCloud?45000:8000;let syncFlight=null,syncTimer=null,syncAgain=false,lastReadRequest=0,cloudWrites=0;let writeQueue=Promise.resolve();
  function requestSync(){if(closed||!config.automatic||!config.companyId)return;if(running||cloudWrites){syncAgain=true;return;}if(syncTimer)return;syncTimer=setTimeout(()=>{syncTimer=null;if(!closed)void synchronize();},80);syncTimer.unref();}
  function synchronize(){if(syncFlight)return syncFlight;const task=runSynchronize();syncFlight=task;void task.finally(()=>{if(syncFlight===task)syncFlight=null;});return task;}
  let config={url:product==='retail'?cloudOrigin.replace(/\/retail\/?$/,'')+'/retail':cloudOrigin,automatic:true},tokens=new Map(),running=false,lastError='',lastSync=null,closed=false,connecting=false,saveQueue=Promise.resolve();
  try{const saved=JSON.parse(await readFile(filename,'utf8'));config=saved.config;if(unprotect&&saved.tokens)tokens=new Map(JSON.parse(await unprotect(Buffer.from(saved.tokens,'base64'))));}catch{}
  if(config.companyId&&!store.companies.has(config.companyId)){config={url:config.url||defaultCloud,automatic:false};tokens.clear();await writeFile(filename,JSON.stringify({config}));}
  lastSync=config.lastSuccessfulSync||null;
  function save(){store.cloudConnectionCompanyId=config.companyId||null;const task=saveQueue.then(async()=>{const saved={config};if(protect)saved.tokens=(await protect(Buffer.from(JSON.stringify([...tokens])))).toString('base64');await writeFile(filename+'.tmp',JSON.stringify(saved));await rename(filename+'.tmp',filename);});saveQueue=task.catch(()=>{});return task;}
  function cloudURL(value){const url=new URL(value||defaultCloud);if(url.username||url.password||url.search||url.hash||!['/','/retail','/retail/'].includes(url.pathname)||(url.protocol!=='https:'&&!(allowTestCloud&&url.protocol==='http:'&&url.hostname==='127.0.0.1')))throw Error('استخدم عنوان الخادم عبر HTTPS؛ مسار /retail متاح للمطاعم');return url.origin+(url.pathname.startsWith('/retail')?'/retail':'');}
  config.url=cloudURL(config.url);store.cloudConnectionCompanyId=config.companyId||null;
  async function remote(path,{body,method='GET',token}={}){
    const response=await fetch(config.url+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(45000)])});
    if(!response.ok){let message;try{message=(await response.json()).error?.message;}catch{}const error=Error(message||'تعذر الاتصال بالخادم: '+response.status);error.status=response.status;throw error;}
    return response;
  }
  async function localAccount(req){const cookie=(req.headers.cookie||'').match(product==='retail'?/(?:^|;\s*)almahasib_retail_session=([^;]+)/:/(?:^|;\s*)almahasib_session=([^;]+)/);const token=req.headers.authorization?.replace(/^Bearer /,'')||cookie?.[1];return token?store.getSessionContext(hashToken(token)):null;}
  async function authorized(req,res,permission,{anyCompany=false}={}){const account=await localAccount(req);if(!account?.company||!account.permissions.includes(permission)||!anyCompany&&config.companyId&&account.company.id!==config.companyId){res.status(403).json({error:{message:'سجّل الدخول بحساب مخوّل'}});return null;}return account;}
  const pending=()=>[...store.desktopCommands.values()].filter(x=>x.companyId===config.companyId&&x.local&&x.status!=='acknowledged');
  const status=()=>({companyCode:config.companyId?store.companies.get(config.companyId)?.code:undefined,connected:!!config.companyId,automatic:config.automatic,running,pending:pending().length,conflicts:pending().filter(x=>x.status==='conflict').length,lastSuccessfulSync:lastSync,error:lastError,url:config.url});
  function mapped(value){if(typeof value==='string')return store.desktopIdMappings.get(value)?.remoteId||value;if(Array.isArray(value))return value.map(mapped);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[mapped(key),mapped(v)]));return value;}
  function remember(local,remote,generated){if(typeof local==='string'&&typeof remote==='string'&&/^[0-9a-f-]{36}$/i.test(local)&&/^[0-9a-f-]{36}$/i.test(remote)&&local!==remote&&(!generated||generated.includes(local)))store.desktopIdMappings.set(local,{companyId:config.companyId,remoteId:remote});else if(Array.isArray(local)&&Array.isArray(remote))local.forEach((v,i)=>remember(v,remote[i],generated));else if(local&&remote&&typeof local==='object'&&typeof remote==='object')for(const key of Object.keys(local))remember(local[key],remote[key],generated);}
  async function applyCloudDeletion(companyId,code) {
    await store.deletePlatformCompany(companyId,null,{confirm:true,code});
    config={url:config.url,automatic:false};tokens.clear();await save();
  }
  async function runSynchronize(){
    if(running||connecting||cloudWrites)return {state:'busy',...status()};if(!config.companyId)return {state:'failed',message:'اربط الجهاز بالشركة السحابية أولًا',...status()};
    running=true;lastError='';
    try{
      // Fail closed before replay; a revoked session alone cannot identify a deleted tenant.
      const notice=await (await remote('/api/v1/company/deletion-notice?companyId='+encodeURIComponent(config.companyId))).json();
      if(notice.companyId!==config.companyId||typeof notice.deleted!=='boolean')throw Error('تعذر التحقق من حالة الشركة');
      if(notice.deleted){await applyCloudDeletion(config.companyId,config.companyCode);return {state:'deleted',...status()};}
      if(config.deletionPending?.kind==='account') {
        // The owner remains active: account deletion cannot remove the company owner.
        // Reconcile a lost account-deletion response against the authoritative snapshot.
        const token=tokens.get(config.directorId);if(!token)throw Error('جلسة المدير مطلوبة لمراجعة نتيجة حذف الحساب');
        const bytes=Buffer.from(await (await remote('/api/v1/enterprise/backup',{token})).arrayBuffer());
        if(!await store.importCloudSnapshot(bytes,config.companyId))throw Error('راجع العمليات المعلقة قبل حسم حذف الحساب');
        const userId=config.deletionPending.userId;
        if(store.users.get(userId)?.deletedAt){tokens.delete(userId);tokens.delete(mapped(userId));}
        delete config.deletionPending;await save();
      }
      if(config.deletionPending)throw Error('طلب حذف سحابي معلّق؛ أعد العملية للتحقق قبل المزامنة');
      for(const command of pending()){
        if(command.status==='conflict')throw Error('توجد عملية مرفوضة تحتاج مراجعة قبل متابعة المزامنة: '+command.error);
        const token=tokens.get(command.userId)||tokens.get(mapped(command.userId));if(!token)throw Error('يلزم تسجيل دخول سحابي للمستخدم الذي أنشأ العملية');
        // Freeze the exact transmitted request before the first network attempt.
        // A lost acknowledgement always retries this identical request and UUID.
        await store.transaction(async()=>{if(!command.transmitted&&!command.transmittedProtected){const body=command.bodyProtected?JSON.parse((await unprotect(Buffer.from(command.bodyProtected,'base64'))).toString()):command.body;const request={id:command.id,method:command.method,path:command.path.replace(/[0-9a-f-]{36}/gi,id=>mapped(id)),body:mapped(body)};if(protect)command.transmittedProtected=(await protect(Buffer.from(JSON.stringify(request)))).toString('base64');else command.transmitted=request;store.desktopCommands.set(command.id,command);}});
        const transmitted=command.transmittedProtected?JSON.parse((await unprotect(Buffer.from(command.transmittedProtected,'base64'))).toString()):command.transmitted;
        let response;
        try{
          const raw=await fetch(config.url+'/api/v1/desktop/commands',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(transmitted),signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(45000)])});
          const result=await raw.json();
          if(!raw.ok){if(raw.status>=400&&raw.status<500&&![401,408,429].includes(raw.status))await store.transaction(()=>{command.status='conflict';command.error=result.error?.message||'رفض الخادم العملية';store.desktopCommands.set(command.id,command);});throw Error(result.error?.message||'تعذر إرسال العملية');}
          if(result.id!==command.id||!result.result||result.result.status>=400)throw Error('استجابة المزامنة غير مكتملة؛ بقيت العملية محفوظة');
          response=result.result;
        }catch(error){throw error;}
        await store.transaction(()=>{remember(command.result?.body,response.body,command.generatedIds);command.status='acknowledged';command.acknowledgedAt=new Date().toISOString();store.desktopCommands.set(command.id,command);});
      }
      const token=tokens.get(config.directorId);if(!token)throw Error('جلسة المدير مطلوبة لاستقبال بيانات الشركة');
      const bytes=Buffer.from(await (await remote('/api/v1/enterprise/backup',{token})).arrayBuffer());
      if(await store.importCloudSnapshot(bytes,config.companyId)){lastSync=new Date().toISOString();config.lastSuccessfulSync=lastSync;await save();}
      return {state:'complete',...status()};
    }catch(error){lastError=error.message;return {state:'failed',message:lastError,...status()};}
    finally{running=false;if(syncAgain&&!closed){syncAgain=false;requestSync();}}
  }

  app.post('/api/local/settings/transfer-owner',async(req,res)=>{
    let ownsLock=false;
    try{
      const account=await authorized(req,res,'company.manage');if(!account)return;
      assertSettingsScope(account,'users.manage');await confirmSettingsOperation(store,account,req.body,'transfer');
      if(account.company.id!==config.companyId||running||connecting||pending().length)throw Error('تحقق من ربط الشركة وأنه لا توجد مزامنة أو عمليات معلقة');
      connecting=true;ownsLock=true;
      const token=tokens.get(account.user.id)||tokens.get(mapped(account.user.id));if(!token)throw Error('سجّل دخول المالك السحابي');
      const result=await (await remote('/api/v1/settings/transfer-owner',{method:'POST',body:req.body,token})).json();
      await store.transferCompanyOwnership(account,String(req.body.newOwnerId||''),req.body.reason);res.json(result);
    }catch(error){res.status(error.status||400).json({error:{message:error.message}});}finally{if(ownsLock)connecting=false;}
  });
  app.post('/api/local/settings/erase-company',async(req,res)=>{
    let ownsLock=false;
    try {
      const account=await authorized(req,res,'local.data.delete',{anyCompany:true});if(!account)return;
      assertSettingsScope(account,'local.data.delete');
      const reason=await confirmSettingsOperation(store,account,req.body,'local');
      if(running||connecting)throw Error('انتظر انتهاء الربط أو المزامنة');
      if([...store.desktopCommands.values()].some(x=>x.companyId===account.company.id&&x.local&&x.status!=='acknowledged'))throw Error('راجع العمليات غير المرسلة قبل مسح النسخة المحلية');
      connecting=true;ownsLock=true;
      // Persist detachment before erasing state: a restart cannot restore it automatically.
      if(config.companyId===account.company.id){config={url:config.url,automatic:false};tokens.clear();await save();}
      const result=await store.transaction(async()=>{
        const backupId=await settingsBackup(store,account,reason,'local');
        const result=await store.deletePlatformCompany(account.company.id,account.user.id,{confirm:true,code:account.company.code});
        store.deletedCompanies.set(account.company.id,{...result.deletion,localOnly:true});
        await store.recordDeletionEvidence(account,{kind:'local',reason,backupId});return {...result,backupId,cloudDeleted:false};
      });res.json(result);
    }catch(error){res.status(error.status||400).json({error:{code:error.code,message:error.message}});}finally{if(ownsLock)connecting=false;}
  });
  for(const kind of ['account','company'])app.post('/api/local/settings/delete-cloud-'+kind,async(req,res)=>{
    let ownsLock=false;
    try {
      const account=await authorized(req,res,kind==='account'?'account.delete':'company.delete');if(!account)return;
      assertSettingsScope(account,kind==='account'?'account.delete':'company.delete');
      await confirmSettingsOperation(store,account,req.body,kind);
      if(account.company.id!==config.companyId)throw Error('الحساب لا يطابق الشركة السحابية المرتبطة');
      if(running||connecting)throw Error('انتظر انتهاء الربط أو المزامنة');
      if(pending().length)throw Error('راجع العمليات غير المرسلة قبل الحذف السحابي');
      const token=tokens.get(account.user.id)||tokens.get(mapped(account.user.id));if(!token)throw Error('سجّل دخولك السحابي أولًا');
      connecting=true;ownsLock=true;
      if(kind==='company'){
        const notice=await (await remote('/api/v1/company/deletion-notice?companyId='+encodeURIComponent(account.company.id))).json();
        if(notice.deleted===true){await applyCloudDeletion(account.company.id,account.company.code);return res.json({deleted:true,alreadyDeleted:true});}
      }
      const remoteAccount=await (await remote('/api/v1/settings',{token})).json();
      if(remoteAccount.company?.id!==account.company.id||remoteAccount.user?.id!==mapped(account.user.id))throw Error('الهوية السحابية لا تطابق الحساب المحلي');
      // Durable ambiguity flag prevents replay if the cloud committed but the response was lost.
      config.deletionPending={kind,userId:account.user.id};await save();
      const result=await (await remote('/api/v1/settings/delete-'+kind,{method:'POST',body:req.body,token})).json();
      if(kind==='company')await applyCloudDeletion(account.company.id,account.company.code);
      else {await store.deleteOwnAccount(account);tokens.delete(account.user.id);tokens.delete(mapped(account.user.id));delete config.deletionPending;await save();}
      res.json(result);
    }catch(error){if(error.status>=400&&error.status<500&&config.deletionPending){delete config.deletionPending;await save();}res.status(error.status||400).json({error:{code:error.code,message:error.message}});}finally{if(ownsLock)connecting=false;}
  });

  const checkConnectivity=createConnectivityProbe({cloudURL:()=>config.url});
  app.get('/api/local/connectivity',async(req,res)=>{try{const connection=await checkConnectivity();res.setHeader('Cache-Control','no-store');res.json({...connection,linked:!!config.companyId,automatic:config.automatic,lastSuccessfulSync:lastSync,synchronizationError:!!lastError});}catch{res.status(503).json({internet:false,cloud:false,checkedAt:new Date().toISOString()});}});
  app.get('/api/local/cloud/status',async(req,res)=>{if(await authorized(req,res,'sync.use'))res.json(status());});
  app.post('/api/local/cloud/synchronize',async(req,res)=>{if(await authorized(req,res,'sync.use'))res.json(await synchronize());});
  app.put('/api/local/cloud/settings',async(req,res)=>{if(!await authorized(req,res,'company.manage'))return;if(typeof req.body.automatic!=='boolean')return res.status(400).json({error:{message:'إعداد غير صالح'}});config.automatic=req.body.automatic;await save();res.json(status());});
  app.get('/api/local/cloud/commands',async(req,res)=>{const account=await authorized(req,res,'sync.use');if(!account)return;res.json({commands:pending().filter(x=>account.permissions.includes('company.manage')||x.userId===account.user.id).map(x=>({id:x.id,path:x.path,method:x.method,status:x.status,error:x.error,createdAt:x.createdAt}))});});
  app.post('/api/local/cloud/commands/:id/retry',async(req,res)=>{const account=await authorized(req,res,'sync.use');if(!account)return;const command=store.desktopCommands.get(req.params.id);if(!command?.local||command.companyId!==account.company.id||(!account.permissions.includes('company.manage')&&command.userId!==account.user.id))return res.status(404).json({error:{message:'العملية غير موجودة'}});if(running)return res.status(409).json({error:{message:'انتظر انتهاء المزامنة'}});await store.transaction(()=>{command.status='pending';command.error=null;command.reviewedBy=account.user.id;command.reviewedAt=new Date().toISOString();store.desktopCommands.set(command.id,command);});res.json({saved:true});});
  app.post('/api/local/cloud/reset',async(req,res)=>{
    let ownsLock=false;try{if(!await authorized(req,res,'company.manage'))return;if(req.body.confirm!==true)throw Error('أكد اعتماد نسخة السحابة');if(running||connecting)throw Error('انتظر انتهاء المزامنة');connecting=true;ownsLock=true;
      const token=tokens.get(config.directorId);if(!token)throw Error('سجّل دخول المدير للاتصال بالسحابة');
      const bytes=Buffer.from(await(await remote('/api/v1/enterprise/backup',{token})).arrayBuffer());
      const backup=await store.exportBackup();const backupName='before-cloud-review-'+Date.now()+'.sqlite';await writeFile(join(dataDirectory,backupName),backup);
      await store.importCloudSnapshot(bytes,config.companyId,{initial:true,discardPending:true});lastSync=new Date().toISOString();res.json({saved:true,backupName});
    }catch(error){res.status(400).json({error:{message:error.message}});}finally{if(ownsLock)connecting=false;}
  });
  async function connectAccount(req,res){
    let ownsLock=false;try{
      if(store.companies.size&&!await authorized(req,res,'company.manage',{anyCompany:true}))return;
      if(connecting||running)throw Error('عملية ربط أو مزامنة قيد التنفيذ');
      if(pending().length)throw Error('توجد عمليات غير مرسلة؛ لا يمكن تغيير الاتصال أو استبدال البيانات');
      if(req.body.adopt!==true)throw Error('اختر اعتماد بيانات الشركة السحابية لتهيئة الجهاز');
      connecting=true;ownsLock=true;
      const previous=config;config={...config,url:cloudURL(req.body.url)};
      let account,token,bytes;
      try{
        const login=await (await remote('/api/v1/auth/login',{method:'POST',body:{companyCode:req.body.companyCode,username:req.body.username,password:req.body.password}})).json();account=login.account;token=login.token;
        if(product!=='unified'&&(account.company.product||'company')!==product)throw Error('الشركة السحابية تتبع منتجًا مختلفًا');
        if(!account.permissions.includes('company.manage')||!account.permissions.includes('sync.use'))throw Error('استخدم حساب مدير الشركة للربط الأول');
        bytes=Buffer.from(await(await remote('/api/v1/enterprise/backup',{token})).arrayBuffer());
      }catch(error){config=previous;throw error;}
      const backup=await store.exportBackup();await writeFile(join(dataDirectory,'before-cloud-'+Date.now()+'.sqlite'),backup);
      await store.importCloudSnapshot(bytes,account.company.id,{initial:true});
      config={...config,companyId:account.company.id,companyCode:account.company.code,directorId:account.user.id};tokens=new Map([[account.user.id,token]]);await save();
      if(typeof res.cookie==='function') {
        const sessionToken=newSessionToken(),days=30;
        await store.createSession({tokenHash:hashToken(sessionToken),userId:account.user.id,deviceId:'desktop-cloud-link',expiresAt:new Date(Date.now()+days*86400000).toISOString()});
        res.cookie(product==='retail'?'almahasib_retail_session':'almahasib_session',sessionToken,{httpOnly:true,sameSite:'strict',secure:req.secure===true,path:'/',maxAge:days*86400000});
      }
      res.json({connected:true,companyCode:account.company.code});
    }catch(error){res.status(400).json({error:{message:error.message}});}finally{if(ownsLock)connecting=false;}
  }
  app.post('/api/local/cloud/connect',connectAccount);
  // An empty company device is provisioned from the approved central account.
  // Existing databases are never replaced by an ordinary login.
  app.post('/api/v1/auth/login',async(req,res,next)=>{
    if(req.body.platform===true)return res.status(403).json({error:{message:'دخول المطور متاح من لوحة السحابة'}});
    if(store.companies.size)return next();
    let statusCode=200,result;
    const reply={status(code){statusCode=code;return this;},json(value){result=value;}};
    await connectAccount({...req,body:{...req.body,url:config.url,adopt:true}},reply);
    if(statusCode>=400||!result?.connected)return res.status(statusCode>=400?statusCode:503).json(result||{error:{message:'تعذر تجهيز حساب الشركة'}});
    next();
  });
  app.post('/api/v1/companies/register',async(req,res)=>{
    try{
      const base=cloudURL(config.url).replace(/\/retail$/,'');
      const response=await fetch(base+'/api/v1/companies/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body),signal:AbortSignal.timeout(20000)});
      const result=await response.json();res.status(response.status).json(result);
    }catch{res.status(503).json({error:{message:'لم يصل طلب الإنشاء إلى السحابة؛ تحقق من الاتصال وأعد المحاولة'}});}
  });
  app.use(async(req,_res,next)=>{
    if(config.companyId&&req.path.startsWith('/api/v1/')&&!/^\/api\/v1\/(auth|platform)(\/|$)/.test(req.path)){
      req.url=req.url.replace(/[0-9a-f-]{36}/gi,id=>mapped(id));if(req.body)req.body=mapped(req.body);
      if(req.method==='GET'&&Date.now()-lastReadRequest>15000){const account=await localAccount(req);if(account?.company?.id===config.companyId){lastReadRequest=Date.now();requestSync();}}
    }
    next();
  });
  // The cloud is authoritative while reachable. Persist the replay identity
  // before transmission so a lost reply can never create a second operation.
  app.use(async(req,res,next)=>{
    if(product!=='company'||!config.companyId||!config.automatic||!req.path.startsWith('/api/v1/')||/^\/api\/v1\/(auth|platform|desktop|sync|companies)(\/|$)/.test(req.path))return next();
    const account=await localAccount(req);if(account?.company?.id!==config.companyId)return next();
    const token=tokens.get(account.user.id)||tokens.get(mapped(account.user.id));
    if(req.method==='GET'){
      if(!token)return next();
      try{
        const response=await fetch(config.url+req.url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(onlineTimeout)])});
        const bytes=Buffer.from(await response.arrayBuffer());
        if(response.status>=500||[408,429].includes(response.status))return next();
        res.setHeader('Cache-Control','no-store');res.setHeader('X-AlMahasib-Source','cloud');
        if(response.headers.get('content-type'))res.setHeader('Content-Type',response.headers.get('content-type'));
        return res.status(response.status).send(bytes);
      }catch{return next();}
    }
    if(!commandPathAllowed(req.originalUrl))return next();
    if(closed||connecting||config.deletionPending)return res.status(423).json({error:{message:'انتظر انتهاء الربط أو مراجعة الحذف السحابي'}});
    let release;const previous=writeQueue;writeQueue=new Promise(resolve=>{release=resolve;});await previous;
    let command;
    try{
      if(syncFlight)await syncFlight;
      // Earlier offline commands must be acknowledged before dependent writes.
      if(pending().length)await synchronize();
      cloudWrites++;
      let released=false;const done=()=>{if(released)return;released=true;cloudWrites--;release();requestSync();};res.once('finish',done);res.once('close',done);
      if(!token||pending().length)return next();
      command={id:randomUUID(),local:true,companyId:account.company.id,userId:account.user.id,method:req.method,path:req.originalUrl,result:{status:202,body:null},status:'pending',createdAt:new Date().toISOString(),generatedIds:[]};
      const body=structuredClone(req.body||{}),transmitted={id:command.id,method:req.method,path:req.url,body:mapped(body)};
      if(protect){command.bodyProtected=(await protect(Buffer.from(JSON.stringify(body)))).toString('base64');command.transmittedProtected=(await protect(Buffer.from(JSON.stringify(transmitted)))).toString('base64');}
      else{command.body=body;command.transmitted=transmitted;}
      await store.transaction(()=>store.desktopCommands.set(command.id,command));
      req.cloudFirstCommand=command;
      const response=await fetch(config.url+'/api/v1/desktop/commands',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(transmitted),signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(onlineTimeout)])});
      const result=await response.json();
      if(!response.ok){
        if(response.status>=400&&response.status<500&&![408,429].includes(response.status)){
          // An explicit rejection is never reinterpreted as an offline success.
          await store.transaction(()=>store.desktopCommands.delete(command.id));
          return res.status(response.status).json(result);
        }
        return next();
      }
      if(result.id!==command.id||!result.result||result.result.status>=400)return next();
      await store.transaction(()=>{command.status='acknowledged';command.result=result.result;command.acknowledgedAt=new Date().toISOString();store.desktopCommands.set(command.id,command);});
      res.setHeader('X-AlMahasib-Source','cloud');return res.status(result.result.status).json(result.result.body);
    }catch(error){
      if(req.cloudFirstCommand)return next();
      release();return res.status(503).json({error:{message:'تعذر حفظ طلب الإرسال بأمان؛ أعد المحاولة'}});
    }
  });
  const idsIn=(value,ids=new Set())=>{if(typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value))ids.add(value);else if(value instanceof Map)for(const [key,row] of value){idsIn(key,ids);idsIn(row,ids);}else if(Array.isArray(value))for(const row of value)idsIn(row,ids);else if(value&&typeof value==='object')for(const row of Object.values(value))idsIn(row,ids);return ids;};
  // Commit the domain mutation and its replay command together before releasing
  // the HTTP response. Server rejection restores every domain field.
  app.use(async(req,res,next)=>{
    if(config.deletionPending&&req.path!=='/api/v1/auth/login'&&['POST','PUT','PATCH','DELETE'].includes(req.method))return res.status(423).json({error:{message:'نتيجة حذف سحابي تحتاج مراجعة؛ شغّل المزامنة قبل العمليات الجديدة'}});
    if(connecting&&['POST','PUT','PATCH','DELETE'].includes(req.method))return res.status(423).json({error:{message:'جاري تهيئة بيانات الشركة؛ أعد المحاولة بعد الربط'}});
    const isLogin=req.method==='POST'&&req.path==='/api/v1/auth/login';
    const capture=config.companyId&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&commandPathAllowed(req.originalUrl);
    if(!capture&&!isLogin)return next();
    const account=capture?await localAccount(req):null;
    if(capture&&(!account||account.company?.id!==config.companyId))return next();
    const end=res.end.bind(res);let output;
    try{
      await store.transaction(()=>{const knownIds=capture?idsIn(Object.fromEntries(Object.entries(store).filter(([,value])=>value instanceof Map||Array.isArray(value)))):new Set();return new Promise((resolve,reject)=>{
        res.end=(chunk,encoding,callback)=>{output={chunk,encoding,callback};let body=null;try{body=chunk?JSON.parse(Buffer.isBuffer(chunk)?chunk.toString():String(chunk)):null;}catch{}
          if(res.statusCode>=400){const error=Error('request rejected');error.localResponse=true;reject(error);return res;}
          const accepted=(!body?.result?.status||body.result.status==='acknowledged')&&(!body?.results||body.results.every(x=>x.status==='acknowledged'));
          if(capture&&accepted){const id=req.cloudFirstCommand?.id||randomUUID(),command={...req.cloudFirstCommand,id,local:true,companyId:account.company.id,userId:account.user.id,method:req.method,path:req.originalUrl,result:{status:res.statusCode,body},status:'pending',createdAt:req.cloudFirstCommand?.createdAt||new Date().toISOString(),generatedIds:[...idsIn(body)].filter(id=>!knownIds.has(id))};
            if(protect){Promise.resolve(protect(Buffer.from(JSON.stringify(req.body||{})))).then(bytes=>{command.bodyProtected=bytes.toString('base64');store.desktopCommands.set(id,command);resolve();}).catch(reject);return res;}
            command.body=structuredClone(req.body||{});store.desktopCommands.set(id,command);}
          if(isLogin&&body?.account?.company?.id===config.companyId){void (async()=>{try{const login=await(await remote('/api/v1/auth/login',{method:'POST',body:req.body})).json();if(login.account.user.id===mapped(body.account.user.id)){tokens.set(login.account.user.id,login.token);await save();requestSync();}}catch{}finally{resolve();}})();return res;}
          resolve();return res;
        };next();
      });});
    }catch(error){if(!error.localResponse){res.statusCode=500;output={chunk:JSON.stringify({error:{message:'تعذر حفظ العملية؛ لم يتم اعتمادها'}})};}}
    finally{res.end=end;if(output){end(output.chunk,output.encoding,output.callback);if(capture&&res.statusCode<400)requestSync();}}
  });
  const timer=setInterval(requestSync,5000);timer.unref();requestSync();
  return {synchronize,status,async close(){closed=true;clearInterval(timer);clearTimeout(syncTimer);await writeQueue;await syncFlight;await saveQueue;shutdown.abort();}};
}
