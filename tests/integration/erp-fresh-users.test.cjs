const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function fixture(){
 const account={company:{id:'company',code:'co11'},user:{id:'director'},permissions:['sync.use','users.manage','sales.create'],scopes:[],offlineSessionExpiresAt:new Date(Date.now()+86400000).toISOString()};
 const signature=JSON.stringify([account.company.id,account.user.id,[...account.permissions].sort(),account.scopes]);
 const master={items:[{id:'item',units:[{unitId:'unit',conversionFactor:'1'}]}],stock:[{warehouseId:'warehouse',itemId:'item',quantity:'10'}]};
 const commits=new Map(),attempts=[];let rejected=false,lost=false;
 const stores={reads:new Map([['/api/v1/users',{path:'/api/v1/users',data:{users:[{username:'director'}]},signature}]]),outbox:new Map()},local=new Map([['almahasib_erp_active_v1',JSON.stringify(account)]]);
 const storage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key),clear:()=>local.clear()};
 const request=value=>{const r={result:value===db?db:structuredClone(value)};setImmediate(()=>r.onsuccess?.());return r;};
 const db={close(){},transaction(name){const tx={objectStore:()=>({get:key=>request(stores[name].get(key)),getAll:()=>request([...stores[name].values()]),put:row=>{stores[name].set(name==='reads'?row.path:row.id,structuredClone(row));setImmediate(()=>tx.oncomplete?.());}})};return tx;}};
 stores.reads.set('/api/v1/master-data',{path:'/api/v1/master-data',data:master,signature});
 let online=true,denied=false,live=[{username:'director'}],reads=0;
 const fetcher=async(input,options={})=>{if(!online)throw Error('offline');const url=new URL(input,'http://127.0.0.1:3213');if(url.pathname==='/api/local/status')return Response.json({local:true});if(url.pathname==='/api/v1/bootstrap')return Response.json(account);if(url.pathname==='/api/v1/master-data')return Response.json(master);if(url.pathname==='/api/v1/commerce/commit'){const command=JSON.parse(options.body);attempts.push(command);if(rejected)return Response.json({error:{message:'رفض الخادم: الفترة مقفلة'}},{status:409});commits.set(command.operationId,command);if(lost){lost=false;throw Error('response lost after commit');}return Response.json({result:{status:'acknowledged',operationId:command.operationId}});}if(url.pathname==='/api/v1/users'){if(denied)return Response.json({error:{message:'unauthorized'}},{status:401});if(options.method==='POST'){const row=JSON.parse(options.body);live.push(row);return Response.json({user:row},{status:201});}reads++;return Response.json({users:structuredClone(live)});}return Response.json({deleted:false});};
 function browser(){const window={fetch:fetcher,addEventListener(){},dispatchEvent(){}};const c={window,fetch:fetcher,localStorage:storage,sessionStorage:storage,indexedDB:{open:()=>request(db)},location:new URL('http://127.0.0.1:3213/enterprise.html'),navigator:{},document:{addEventListener(){},getElementById:()=>null},Response,Headers,URL,AbortSignal,crypto,structuredClone,Date,console,setInterval:()=>0,CustomEvent:class{}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../public/erp-offline.js'),'utf8'),c);return window;}
 return {browser,commits,stores,attempts,setRejected:value=>rejected=value,loseNextResponse:()=>lost=true,setOnline:value=>online=value,setDenied:value=>denied=value,live,reads:()=>reads};
}
test('desktop user list refreshes after creation, survives reload and falls back to the latest cache only offline',async()=>{
 const f=fixture(),w=f.browser();await w.fetch('/api/v1/users');await w.fetch('/api/v1/users',{method:'POST',body:JSON.stringify({username:'new_user'})});
 const fresh=await w.fetch('/api/v1/users');assert.equal(fresh.headers.get('X-AlMahasib-Offline'),null);assert.equal((await fresh.json()).users.length,2);assert.ok(f.reads()>=2);
 f.setOnline(false);const offline=await w.fetch('/api/v1/users');assert.equal(offline.headers.get('X-AlMahasib-Offline'),'true');assert.equal((await offline.json()).users.length,2);
 f.setOnline(true);f.live.push({username:'web_user'});const restarted=f.browser();assert.equal((await (await restarted.fetch('/api/v1/users')).json()).users.length,3);
 f.setDenied(true);assert.equal((await restarted.fetch('/api/v1/users')).status,401,'Do not hide session revocation behind a cached list');
});

test('a connected desktop returns the confirmed result after durable queuing; offline commands stay pending and replay once',async()=>{
 const f=fixture(),w=f.browser();await w.fetch('/api/v1/bootstrap');
 const command={operationId:'invoice-online',document:{documentType:'sale',warehouseId:'warehouse',lines:[{itemId:'item',unitId:'unit',quantity:'1'}]}};
 const response=await w.fetch('/api/v1/commerce/commit',{method:'POST',body:JSON.stringify(command)});
 assert.equal(response.status,200);assert.equal((await response.json()).result.status,'acknowledged');assert.equal(f.commits.size,1);assert.equal(f.stores.outbox.get(command.operationId).state,'acknowledged');
 const retry=await w.fetch('/api/v1/commerce/commit',{method:'POST',body:JSON.stringify(command)});assert.equal(retry.status,200);assert.equal(f.commits.size,1);assert.equal(f.attempts.length,1);
 f.setOnline(false);await w.fetch('/api/v1/users');const offline={...command,operationId:'invoice-offline'};
 const pending=await w.fetch('/api/v1/commerce/commit',{method:'POST',body:JSON.stringify(offline)});assert.equal(pending.status,202);assert.equal((await pending.json()).result.status,'pending');assert.equal(f.commits.size,1);
 await w.AlMahasibERP.synchronize();f.setOnline(true);await w.AlMahasibERP.synchronize();assert.equal(f.commits.size,2);assert.equal(f.stores.outbox.get(offline.operationId).state,'acknowledged');await w.AlMahasibERP.synchronize();assert.equal(f.commits.size,2);
});

test('rejected invoices remain conflicts; a lost confirmation retries the unchanged operation ID',async()=>{
 const f=fixture(),w=f.browser();await w.fetch('/api/v1/bootstrap');f.loseNextResponse();
 const body={operationId:'lost-confirmation',document:{documentType:'sale',warehouseId:'warehouse',lines:[{itemId:'item',unitId:'unit',quantity:'1'}]}};
 const pending=await w.fetch('/api/v1/commerce/commit',{method:'POST',body:JSON.stringify(body)});assert.equal(pending.status,202);assert.equal(f.commits.size,1);assert.equal(f.stores.outbox.get(body.operationId).state,'sending');
 await w.AlMahasibERP.synchronize();assert.equal(f.stores.outbox.get(body.operationId).state,'acknowledged');assert.equal(f.commits.size,1);assert.equal(f.attempts.length,2);assert.deepEqual(f.attempts[0],f.attempts[1]);
 f.setRejected(true);const rejected={...body,operationId:'rejected-invoice'};const failure=await w.fetch('/api/v1/commerce/commit',{method:'POST',body:JSON.stringify(rejected)});assert.equal(failure.status,409);assert.match((await failure.json()).error.message,/مقفلة/);assert.equal(f.stores.outbox.get(rejected.operationId).state,'conflict');assert.equal(f.commits.size,1);
});
