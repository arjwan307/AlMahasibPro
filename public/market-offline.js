(function(){
'use strict';
let db=null,scope='unscoped',channel=null;
function ctx(){try{return JSON.parse(localStorage.getItem('almahasib_company_context')||'{}')}catch{return{}}}
function key(){return 'tenant:'+scope+':market_catalog_v1'}
function openDb(){const c=ctx();scope=String(c.id||c.code||'unscoped').replace(/[^A-Za-z0-9_-]/g,'_');if(scope==='unscoped')throw new Error('سجّل الدخول إلى الشركة أولاً');return new Promise((ok,no)=>{const r=indexedDB.open('almahasib-market-'+scope,1);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains('snapshots'))d.createObjectStore('snapshots',{keyPath:'key'});if(!d.objectStoreNames.contains('outbox'))d.createObjectStore('outbox',{keyPath:'id'})};r.onsuccess=()=>{db=r.result;channel=new BroadcastChannel('almahasib-market-'+scope);channel.onmessage=()=>window.dispatchEvent(new Event('almahasib:market-update'));ok(db)};r.onerror=()=>no(r.error)})}
function tx(store,mode='readonly'){return db.transaction(store,mode).objectStore(store)}
function req(r){return new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})}
async function saveSnapshot(reason='change'){if(!db)await openDb();const catalog=JSON.parse(localStorage.getItem(key())||'[]'),at=new Date().toISOString();await new Promise((ok,no)=>{const t=db.transaction(['snapshots','outbox'],'readwrite');t.objectStore('snapshots').put({key:'catalog',companyScope:scope,catalog,at});t.objectStore('outbox').put({id:crypto.randomUUID(),companyScope:scope,type:'catalog.snapshot',reason,at,count:catalog.length,state:'pending'});t.oncomplete=ok;t.onerror=()=>no(t.error)});channel?.postMessage({type:'catalog',at});renderStatus();return catalog}
async function restore(){if(!db)await openDb();const row=await req(tx('snapshots').get('catalog'));if(row?.companyScope===scope&&Array.isArray(row.catalog)&&!localStorage.getItem(key()))localStorage.setItem(key(),JSON.stringify(row.catalog));return row}
async function syncCloud(){if(!db)await openDb();if(!navigator.onLine)return;const local=JSON.parse(localStorage.getItem(key())||'[]');const localAt=localStorage.getItem('tenant:'+scope+':market_catalog_updated_at')||'';
  try{
    const remoteRes=await fetch('/api/v1/market/snapshot',{credentials:'same-origin'});if(!remoteRes.ok)throw new Error('pull');const remote=(await remoteRes.json()).snapshot;
    if(remote?.catalog&&String(remote.updatedAt||'')>localAt){localStorage.setItem(key(),JSON.stringify(remote.catalog));localStorage.setItem('tenant:'+scope+':market_catalog_updated_at',remote.updatedAt);await saveSnapshot('cloud-pull');window.dispatchEvent(new Event('almahasib:market-update'))}
    else if(local.length){const push=await fetch('/api/v1/market/snapshot',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalog:local})});if(!push.ok)throw new Error('push')}
    const rows=await req(tx('outbox').getAll());await new Promise((ok,no)=>{const t=db.transaction('outbox','readwrite'),s=t.objectStore('outbox');rows.filter(x=>x.state==='pending').forEach(x=>s.put({...x,state:'synced',syncedAt:new Date().toISOString()}));t.oncomplete=ok;t.onerror=()=>no(t.error)})
  }catch(e){return false}finally{renderStatus()}return true}
async function status(){if(!db)await openDb();const rows=await req(tx('outbox').getAll());return{scope,pending:rows.filter(x=>x.state==='pending').length,online:navigator.onLine}}
async function renderStatus(){const el=document.getElementById('marketSyncStatus');if(!el)return;const s=await status();el.textContent=(s.online?'متصل':'أوف لاين')+' | محفوظ محليًا | انتظار مزامنة: '+s.pending;el.className=s.online?'badge online':'badge offline'}
window.addEventListener('online',()=>{renderStatus();syncCloud()});window.addEventListener('offline',renderStatus);
window.AlMahasibMarketOffline={open:openDb,saveSnapshot,restore,status,renderStatus,syncCloud};
document.addEventListener('DOMContentLoaded',async()=>{try{await openDb();await restore();await renderStatus();if(navigator.onLine)await syncCloud()}catch(e){console.warn(e)}})
})();