const assert=require('node:assert/strict');
const {createLocalServer}=require('../apps/local/server.cjs');
(async()=>{const server=createLocalServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));try{
const base='http://127.0.0.1:'+server.address().port;
assert.equal((await fetch(base+'/')).status,200);
assert.equal((await fetch(base+'/market-cashier.html')).status,200);
assert.equal((await fetch(base+'/pos-ui.js?v=local')).status,200);
const shell=await (await fetch(base+'/market-cashier.html')).text();
assert.ok(shell.includes('<head><script>window.AlMahasibLocalMode=true;</script>'));
const ui=await (await fetch(base+'/pos-ui.js')).text();
assert.ok(ui.includes('if((!window.AlMahasibLocalMode && navigator.onLine))'));
assert.ok((await (await fetch(base+'/')).text()).includes('إنشاء محل محلي'));
assert.equal((await fetch(base+'/server.js')).status,404);
assert.equal((await fetch(base+'/api/v1/sync/push',{method:'POST'})).status,503);
const hostStatus=await new Promise((ok,no)=>require('node:http').get(base+'/',{headers:{host:'evil.example'}},r=>{r.resume();ok(r.statusCode)}).on('error',no));
assert.equal(hostStatus,403);
console.log('PASS: offline local shell, static isolation, host validation, sync never falsely acknowledged');
}finally{await new Promise(ok=>server.close(ok))}})().catch(e=>{console.error(e);process.exitCode=1});
