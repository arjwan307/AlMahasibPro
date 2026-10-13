import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectivityProbe} from '../../apps/local/connectivity.js';

test('actual health and internet probes distinguish internet availability from cloud outage',async()=>{
 let calls=0,clock=1000,cloudHealthy=false;const check=createConnectivityProbe({cloudURL:()=> 'https://cloud.example',clock:()=>clock,internetURLs:['https://internet.example/204'],fetcher:async url=>{calls++;return url.includes('cloud.example')?{ok:cloudHealthy,status:cloudHealthy?200:503,json:async()=>({ok:true,service:'AlMahasibPro'})}:{status:204};}});
 const first=await check();assert.equal(first.internet,true);assert.equal(first.cloud,false);await check();assert.equal(calls,2);
 clock+=16000;cloudHealthy=true;const second=await check();assert.equal(second.cloud,true);assert.equal(second.internet,true);assert.notEqual(second.checkedAt,first.checkedAt);
});
test('captive portal HTML and failed requests never produce a green connectivity indicator',async()=>{
 const check=createConnectivityProbe({cloudURL:()=> 'https://cloud.example',internetURLs:['https://internet.example/204'],fetcher:async url=>url.includes('cloud.example')?{ok:true,json:async()=>({ok:true,service:'wrong-service'})}:{status:200}});
 assert.deepEqual(await check(),{internet:false,cloud:false,checkedAt:(await check()).checkedAt});
 const unavailable=createConnectivityProbe({cloudURL:()=> 'https://cloud.example',internetURLs:['https://internet.example/204'],fetcher:async()=>{throw Error('network unavailable');}});assert.equal((await unavailable()).internet,false);assert.equal((await unavailable()).cloud,false);
});
test('cloud response proves internet access when public internet probes are blocked; URL changes invalidate cache',async()=>{
 let url='https://first.example',calls=0;const check=createConnectivityProbe({cloudURL:()=>url,internetURLs:[],fetcher:async target=>{calls++;return {ok:true,json:async()=>({ok:true,service:target.startsWith('https://first')?'AlMahasibPro':'wrong-service'})};}});
 const [a,b]=await Promise.all([check(),check()]);assert.equal(a.internet,true);assert.equal(b.cloud,true);assert.equal(calls,1);
 url='https://second.example';assert.equal((await check()).cloud,false);assert.equal(calls,2);
});
