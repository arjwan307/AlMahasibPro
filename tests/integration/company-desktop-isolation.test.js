import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {MongoStore} from '../../apps/api/src/store/mongo-store.js';
import {SQLiteStore} from '../../apps/api/src/store/sqlite-store.js';
import {createApp} from '../../apps/api/src/app.js';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';
import {hashPassword} from '../../apps/api/src/lib/security.js';
const {companyRuntimeOptions,prepareCompanyRuntime}=createRequire(import.meta.url)('../../apps/desktop/company-runtime.cjs');

test('company desktop ignores legacy shared data and port environment settings',()=>{
 const options=companyRuntimeOptions('/application-data',{ALMAHASIB_DATA_DIR:'/cashier-data',ALMAHASIB_PORT:'3211'});
 assert.equal(options.dataDirectory,join('/application-data','AlMahasibProCompanies'));
 assert.equal(options.port,3213);assert.equal(options.appId,'com.almahasibpro.companies');
 assert.notEqual(options.partition,'persist:almahasib-retail');
 assert.throws(()=>companyRuntimeOptions('/application-data',{ALMAHASIB_COMPANY_PORT:'invalid'}));
});

for(const format of ['sqlite','mongo','mongo-existing'])test(`fresh company desktop binds co11 from ${format}, signs in locally and retains legacy cashier ma2022 unchanged`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'company-desktop-isolation-'));let runtime,cloudServer,cloud;
 try{
  const legacyDir=join(dir,'AlMahasibPro'),legacy=new SQLiteStore(join(legacyDir,'enterprise.sqlite'));
  await legacy.transaction(()=>legacy.companies.set('legacy-cashier',{id:'legacy-cashier',code:'ma2022',product:'retail',legalName:'Legacy cashier'}));
  await legacy.close();const oldDatabase=await readFile(join(legacyDir,'enterprise.sqlite'));
  const oldConfig=JSON.stringify({config:{companyCode:'ma2022',url:'https://cashier.example',automatic:true}});await writeFile(join(legacyDir,'cloud-connection.json'),oldConfig);
  cloud=new SQLiteStore(join(dir,'cloud','enterprise.sqlite'));
  const password='Isolation-Strong-123';
  const company=await cloud.registerCompany({code:'co11',legalName:'Cloud company',timezone:'Asia/Baghdad',currency:'IQD',owner:{username:'cloud_owner',displayName:'Owner',passwordHash:await hashPassword(password)}});
  await cloud.approveCompany(company.id,company.ownerUserId,'co11');
  if(format.startsWith('mongo')) {
   const portable=new MongoStore({}, {collection:()=>({})});
   for(const [key,value] of Object.entries(cloud))if(value instanceof Map||Array.isArray(value)||key==='changeSequence')portable[key]=value;
   cloud.exportCompanyBackup=id=>portable.exportCompanyBackup(id);cloud.backupExtension='mongo';
  }
  cloudServer=await new Promise(resolve=>{const server=createApp({store:cloud,productScope:'company'}).listen(0,'127.0.0.1',()=>resolve(server));});
  const cloudOrigin='http://127.0.0.1:'+cloudServer.address().port;
  const options=companyRuntimeOptions(dir,{});
  runtime=await startEnterpriseLocal({dataDirectory:options.dataDirectory,port:33241,product:'company',allowTestCloud:true,cloudOrigin});
  const initial=await (await fetch(runtime.url+'/api/local/status')).json();assert.equal(initial.initialized,false);assert.equal(initial.companyCode,undefined);
  const landing=await fetch(runtime.url+'/index.html',{redirect:'manual'});assert.equal(landing.status,302);assert.equal(landing.headers.get('location'),'/enterprise.html');
  let localCookie='';
  if(format==='mongo-existing') {
   const setup=await fetch(runtime.url+'/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({legalName:'Existing local company',ownerName:'Local owner',username:'local_owner',password})});assert.equal(setup.status,201);
   const signIn=await fetch(runtime.url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({companyCode:'local',username:'local_owner',password})});assert.equal(signIn.status,200);localCookie=signIn.headers.get('set-cookie').split(';')[0];
  }
  const linked=await fetch(runtime.url+'/api/local/cloud/connect',{method:'POST',headers:{'Content-Type':'application/json',Connection:'close',Cookie:localCookie},body:JSON.stringify({url:cloudOrigin,companyCode:'co11',username:'cloud_owner',password,adopt:true})});
  const response=await linked.json();assert.equal(linked.status,200,JSON.stringify(response));assert.equal(response.companyCode,'co11');
  const login=await fetch(runtime.url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({companyCode:'co11',username:'cloud_owner',password})});
  const loggedIn=await login.json();assert.equal(login.status,200,JSON.stringify(loggedIn));assert.ok(loggedIn.account.permissions.includes('company.manage'));
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const bootstrap=await fetch(runtime.url+'/api/v1/bootstrap',{headers:{Cookie:cookie,Connection:'close'}});assert.equal(bootstrap.status,200,JSON.stringify(await bootstrap.json()));
  assert.equal([...runtime.store.companies.values()].some(x=>x.code==='ma2022'),false);
  assert.equal((await (await fetch(runtime.url+'/api/local/status')).json()).companyCode,'co11');
  assert.deepEqual(await readFile(join(legacyDir,'enterprise.sqlite')),oldDatabase);assert.equal(await readFile(join(legacyDir,'cloud-connection.json'),'utf8'),oldConfig);
 }finally{await runtime?.close();if(cloudServer)await new Promise(r=>cloudServer.close(r));await cloud?.close();await rm(dir,{recursive:true,force:true});}
});


test('fresh Electron startup creates isolated data and browser directories before overriding paths',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'company-electron-paths-'));const paths={};
 try{const app={getPath:name=>{assert.equal(name,'appData');return directory;},setName:()=>{},setAppUserModelId:id=>assert.equal(id,'com.almahasibpro.companies'),setPath:(name,value)=>{assert.ok(statSync(value).isDirectory());paths[name]=value;}};
 const options=prepareCompanyRuntime(app,{});assert.equal(paths.userData,options.dataDirectory);assert.equal(paths.sessionData,join(options.dataDirectory,'Browser'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('Mongo snapshot conversion rejects corruption and other tenants without changing local data',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mongo-snapshot-'));const local=new SQLiteStore(join(directory,'local.sqlite'));
 try{
  const portable=new MongoStore({}, {collection:()=>({})});
  portable.companies.set('cloud-company',{id:'cloud-company',code:'co11',product:'company'});
  local.companies.set('local-company',{id:'local-company',code:'local',product:'company'});
  const bytes=await portable.exportCompanyBackup('cloud-company');const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
  await assert.rejects(local.importCloudSnapshot(corrupt,'cloud-company',{initial:true}),/تالفة/);
  await assert.rejects(local.importCloudSnapshot(bytes,'wrong-company',{initial:true}),/لا تخص/);
  assert.equal(local.companies.size,1);assert.ok(local.companies.has('local-company'));
 }finally{await local.close();await rm(directory,{recursive:true,force:true});}
});
