const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'almahasib-packaged-'));let runtime;
 try{
  const modulePath=path.join(process.cwd(),'resources','app.asar','apps','local','enterprise-server.js');
  const {startEnterpriseLocal}=await import(require('node:url').pathToFileURL(modulePath).href);
  runtime=await startEnterpriseLocal({dataDirectory:directory,port:33388});
  for(const asset of ['/enterprise.html','/company-sync-ui.js','/company-messages.js','/company-responsive.css','/desktop-cloud.html'])assert.equal((await fetch(runtime.url+asset)).status,200,asset);
  const response=await fetch(runtime.url+'/api/local/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({legalName:'Packaged smoke test',ownerName:'Owner',username:'owner',password:'Packaged-Test-123'})});assert.equal(response.status,201);
  const login=await fetch(runtime.url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyCode:'local',username:'owner',password:'Packaged-Test-123'})});assert.equal(login.status,200);
  const account=await login.json();assert.ok(account.token);assert.ok(account.account.permissions.includes('company.manage'));
  console.log('PASS: packaged Electron runtime starts SQLite, serves company assets, creates company and authenticates offline');
 }finally{await runtime?.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('almahasib-packaged-'));await fs.rm(resolved,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
