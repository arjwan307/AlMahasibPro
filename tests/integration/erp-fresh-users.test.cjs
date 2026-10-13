const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function fixture(){
 const account={company:{id:'company',code:'co11'},user:{id:'director'},permissions:['sync.use','users.manage'],scopes:[],offlineSessionExpiresAt:new Date(Date.now()+86400000).toISOString()};
 const signature=JSON.stringify([account.company.id,account.user.id,[...account.permissions].sort(),account.scopes]);
 const stores={reads:new Map([['/api/v1/users',{path:'/api/v1/users',data:{users:[{username:'director'}]},signature}]]),outbox:new Map()},local=new Map([['almahasib_erp_active_v1',JSON.stringify(account)]]);
 const storage={getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key),clear:()=>local.clear()};
 const request=value=>{const r={result:value===db?db:structuredClone(value)};setImmediate(()=>r.onsuccess?.());return r;};
 const db={close(){},transaction(name){const tx={objectStore:()=>({get:key=>request(stores[name].get(key)),getAll:()=>request([...stores[name].values()]),put:row=>{stores[name].set(row.path||row.id,structuredClone(row));setImmediate(()=>tx.oncomplete?.());}})};return tx;}};
 let online=true,denied=false,live=[{username:'director'}],reads=0;
 const fetcher=async(input,options={})=>{if(!online)throw Error('offline');const url=new URL(input,'http://127.0.0.1:3213');if(url.pathname==='/api/local/status')return Response.json({local:true});if(url.pathname==='/api/v1/users'){if(denied)return Response.json({error:{message:'unauthorized'}},{status:401});if(options.method==='POST'){const row=JSON.parse(options.body);live.push(row);return Response.json({user:row},{status:201});}reads++;return Response.json({users:structuredClone(live)});}return Response.json({deleted:false});};
 function browser(){const window={fetch:fetcher,addEventListener(){},dispatchEvent(){}};const c={window,fetch:fetcher,localStorage:storage,sessionStorage:storage,indexedDB:{open:()=>request(db)},location:new URL('http://127.0.0.1:3213/enterprise.html'),navigator:{},document:{addEventListener(){},getElementById:()=>null},Response,Headers,URL,AbortSignal,crypto,structuredClone,Date,console,setInterval:()=>0,CustomEvent:class{}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../../public/erp-offline.js'),'utf8'),c);return window;}
 return {browser,setOnline:value=>online=value,setDenied:value=>denied=value,live,reads:()=>reads};
}
test('desktop user list refreshes after creation, survives reload and falls back to the latest cache only offline',async()=>{
 const f=fixture(),w=f.browser();await w.fetch('/api/v1/users');await w.fetch('/api/v1/users',{method:'POST',body:JSON.stringify({username:'new_user'})});
 const fresh=await w.fetch('/api/v1/users');assert.equal(fresh.headers.get('X-AlMahasib-Offline'),null);assert.equal((await fresh.json()).users.length,2);assert.ok(f.reads()>=2);
 f.setOnline(false);const offline=await w.fetch('/api/v1/users');assert.equal(offline.headers.get('X-AlMahasib-Offline'),'true');assert.equal((await offline.json()).users.length,2);
 f.setOnline(true);f.live.push({username:'web_user'});const restarted=f.browser();assert.equal((await (await restarted.fetch('/api/v1/users')).json()).users.length,3);
 f.setDenied(true);assert.equal((await restarted.fetch('/api/v1/users')).status,401,'Do not hide session revocation behind a cached list');
});
