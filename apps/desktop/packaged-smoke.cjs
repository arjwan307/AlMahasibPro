const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'almahasib-packaged-'));let runtime;
 try{
  const modulePath=path.join(process.cwd(),'resources','app.asar','apps','local','enterprise-server.js');
  const {startEnterpriseLocal}=await import(require('node:url').pathToFileURL(modulePath).href);
  runtime=await startEnterpriseLocal({dataDirectory:directory,port:33388});
  for(const asset of ['/enterprise.html','/company-sync-ui.js','/company-messages.js','/company-responsive.css','/app-ui.css','/app-ui.js','/desktop-cloud.html','/data-import.html','/data-import.js'])assert.equal((await fetch(runtime.url+asset)).status,200,asset);
  const response=await fetch(runtime.url+'/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({legalName:'Packaged smoke test',ownerName:'Owner',username:'owner',password:'Packaged-Test-123'})});assert.equal(response.status,201);
  const login=await fetch(runtime.url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:'local',username:'owner',password:'Packaged-Test-123'})});assert.equal(login.status,200);
  const account=await login.json();assert.ok(account.token);assert.ok(account.account.permissions.includes('company.manage'));
  const api=async(url,body)=>{const response=await fetch(runtime.url+url,{headers:{Authorization:'Bearer '+account.token,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  const branches=await api('/api/v1/company/branches');
  const {preview}=await api('/api/v1/data-import/preview',{entity:'customers',branchId:branches.branches[0].id,openingDate:'2026-10-10',mapping:{code:'code',name:'name',openingBalance:'openingBalance',currency:'currency'},expectedBalances:{USD:{net:'12.125',debit:'12.125',credit:'0'}},source:{format:'csv',content:Buffer.from('code,name,openingBalance,currency\nPACKAGED-IMPORT,Packaged customer,12.125,USD').toString('base64')}});
  assert.equal(preview.canCommit,true);
  const first=await api('/api/v1/data-import/'+preview.id+'/commit',{previewHash:preview.hash});
  const retry=await api('/api/v1/data-import/'+preview.id+'/commit',{previewHash:preview.hash});assert.deepEqual(first,retry);assert.equal(first.result.created,1);assert.equal(first.result.journalIds.length,1);
  console.log('PASS: packaged Electron starts SQLite, authenticates offline and imports an opening balance exactly once through the source worker');
 }finally{await runtime?.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('almahasib-packaged-'));await fs.rm(resolved,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
