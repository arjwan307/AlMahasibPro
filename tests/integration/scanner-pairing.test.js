import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { startEnterpriseCloud } from '../../apps/api/src/cloud-server.js';
import { hashToken } from '../../apps/api/src/lib/security.js';

test('retail cashier QR reaches its own scanner link and cannot poll another tenant', async () => {
 const directory=await mkdtemp(join(tmpdir(),'scanner-pairing-'));
 const runtime=await startEnterpriseCloud({dataDirectory:directory,origin:'http://localhost',port:0});
 try {
  const companyId=randomUUID(), otherId=randomUUID(), shiftId=randomUUID();
  runtime.store.getSessionContext=async token=>({company:{id:token===hashToken('other')?otherId:companyId},user:{id:randomUUID()},permissions:['sync.use','pos.shift.open'],scopes:[]});
  runtime.store.pullChanges=async()=>({changes:[{entityType:'market.transaction',payload:{kind:'shift_open',shiftId}}],hasMore:false});
  const request=(path,body,token='owner')=>fetch(runtime.url+path,{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const paired=await request('/retail/api/v1/market/scanner/pair',{shiftId});
  assert.equal(paired.status,200);
  const {token}=await paired.json();
  const source=await(await fetch(runtime.url+'/retail/pos-ui.js')).text();
  const fn=source.slice(source.indexOf('  async function pairPhoneScanner(){'),source.indexOf('  async function disconnectPhoneScanner'));
  let qrUrl;
  const element=()=>({style:{},append(){},showModal(){},remove(){}});
  const context={location:{origin:runtime.url,hostname:'127.0.0.2',pathname:'/retail/market-cashier.html'},window:{AlMahasibMarketOffline:{ensureShiftOpen:async()=>{},syncTransactions:async()=>{}}},getMarketShift:()=>({id:shiftId,status:'open'}),marketCashierId:()=> 'main',saveMarketWork(){},fetch:async()=>({ok:true,json:async()=>({token})}),document:{getElementById:()=>null,createElement:element,body:{append(){}}},qrcode:()=>({addData(value){qrUrl=value;},make(){},createDataURL(){return 'data:';}}),encodeURIComponent,clearInterval(){},setInterval(){},pollPhoneScanner(){},alert(message){throw Error(message);}};
  await runInNewContext('let marketScannerToken=null,marketScannerTimer=null;'+fn+';pairPhoneScanner()',context);
  const target=new URL(qrUrl);
  assert.equal(target.pathname,'/retail/market-scanner.html');
  assert.equal(target.hash,'#'+token);
  const base=target.pathname.replace('/market-scanner.html','');
  assert.equal((await request(base+'/api/v1/market/scanner/'+token+'/status')).status,200);
  assert.equal((await request('/api/v1/market/scanner/'+token+'/status')).status,410);
  assert.equal((await request(base+'/api/v1/market/scanner/'+token+'/poll',null,'other')).status,410);
  assert.equal((await request(base+'/api/v1/market/scanner/'+token+'/scan',{barcode:'SCANNER-TEST'})).status,200);
  const poll=await request(base+'/api/v1/market/scanner/'+token+'/poll');
  assert.equal((await poll.json()).codes[0].barcode,'SCANNER-TEST');
 } finally {await runtime.close();await rm(directory,{recursive:true,force:true});}
});
