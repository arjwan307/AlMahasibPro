'use strict';
// No cloud dependency at startup. Fixed loopback origin keeps browser data stable.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const PUBLIC=path.resolve(__dirname,'../../public');
const ALLOWED=new Set(['market-cashier.html','market-offline.js','market-cashier-ledger.js','pos-ui.js','scanner-qrcode.js','market-trial-catalog.json','market-local-setup.html']);
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
function createLocalServer(){return http.createServer(async(req,res)=>{
  const allowedHosts=new Set(['127.0.0.1:'+res.socket.localPort,'localhost:'+res.socket.localPort]);
  if(!allowedHosts.has(req.headers.host)){res.writeHead(403);res.end('Invalid host');return}
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/')){res.writeHead(503,{'Content-Type':TYPES['.json']});res.end(JSON.stringify({error:{code:'LOCAL_ONLY',message:'المزامنة السحابية غير موصولة في النسخة المحلية؛ الحركات محفوظة على الجهاز'}}));return}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
    const file=url.pathname==='/'?'market-local-setup.html':url.pathname.slice(1);
    if(!ALLOWED.has(file)){res.writeHead(404);res.end('Not found');return}
    let body=await fs.readFile(path.join(PUBLIC,file));
    // Local runtime is intentionally disconnected from the cloud even when
    // the OS has internet. Keep returns and shift closing on the local path.
    if(file.endsWith('.js'))body=Buffer.from(body.toString().replaceAll('navigator.onLine','(!window.AlMahasibLocalMode && navigator.onLine)'));
    if(file.endsWith('.html'))body=Buffer.from(body.toString().replace('<script>','<script>window.AlMahasibLocalMode=true;</script><script>'));
    if(file==='market-cashier.html')body=Buffer.from(body.toString().replace('<head>','<head><script>window.AlMahasibLocalMode=true;</script>'));
    res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end('Not found')}
})}
if(require.main===module){createLocalServer().listen(3210,'127.0.0.1',()=>console.log('المحاسب برو المحلي: http://127.0.0.1:3210'));}
module.exports={createLocalServer};
