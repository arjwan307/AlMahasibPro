import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteStore} from '../../apps/api/src/store/sqlite-store.js';
import {createApp} from '../../apps/api/src/app.js';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';
import {hashPassword} from '../../apps/api/src/lib/security.js';
const {companyRuntimeOptions}=createRequire(import.meta.url)('../../apps/desktop/company-runtime.cjs');

test('company desktop ignores legacy shared data and port environment settings',()=>{
 const options=companyRuntimeOptions('/application-data',{ALMAHASIB_DATA_DIR:'/cashier-data',ALMAHASIB_PORT:'3211'});
 assert.equal(options.dataDirectory,join('/application-data','AlMahasibProCompanies'));
 assert.equal(options.port,3213);assert.equal(options.appId,'com.almahasibpro.companies');
 assert.notEqual(options.partition,'persist:almahasib-retail');
 assert.throws(()=>companyRuntimeOptions('/application-data',{ALMAHASIB_COMPANY_PORT:'invalid'}));
});

test('fresh company desktop binds co11 directly while retaining legacy cashier ma2022 and its connection file unchanged',async()=>{
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
  cloudServer=await new Promise(resolve=>{const server=createApp({store:cloud,productScope:'company'}).listen(0,'127.0.0.1',()=>resolve(server));});
  const cloudOrigin='http://127.0.0.1:'+cloudServer.address().port;
  const options=companyRuntimeOptions(dir,{});
  runtime=await startEnterpriseLocal({dataDirectory:options.dataDirectory,port:33241,product:'company',allowTestCloud:true,cloudOrigin});
  const initial=await (await fetch(runtime.url+'/api/local/status')).json();assert.equal(initial.initialized,false);assert.equal(initial.companyCode,undefined);
  const landing=await fetch(runtime.url+'/index.html',{redirect:'manual'});assert.equal(landing.status,302);assert.equal(landing.headers.get('location'),'/enterprise.html');
  const linked=await fetch(runtime.url+'/api/local/cloud/connect',{method:'POST',headers:{'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({url:cloudOrigin,companyCode:'co11',username:'cloud_owner',password,adopt:true})});
  const response=await linked.json();assert.equal(linked.status,200,JSON.stringify(response));assert.equal(response.companyCode,'co11');
  assert.equal([...runtime.store.companies.values()].some(x=>x.code==='ma2022'),false);
  assert.equal((await (await fetch(runtime.url+'/api/local/status')).json()).companyCode,'co11');
  assert.deepEqual(await readFile(join(legacyDir,'enterprise.sqlite')),oldDatabase);assert.equal(await readFile(join(legacyDir,'cloud-connection.json'),'utf8'),oldConfig);
 }finally{await runtime?.close();if(cloudServer)await new Promise(r=>cloudServer.close(r));await cloud?.close();await rm(dir,{recursive:true,force:true});}
});
