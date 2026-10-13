// Verify responses, not navigator.onLine or merely having a network adapter.
export function createConnectivityProbe({cloudURL,fetcher=fetch,timeoutMs=5000,cacheMs=15000,clock=Date.now,internetURLs=['https://www.gstatic.com/generate_204','https://cp.cloudflare.com/generate_204']}={}) {
 let cached,inflight;
 async function internetProbe(url){try{const r=await fetcher(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});return r.status===204;}catch{return false;}}
 async function cloudProbe(){try{const r=await fetcher(cloudURL()+'/api/health',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});if(!r.ok)return false;const data=await r.json();return data.ok===true&&data.service==='AlMahasibPro';}catch{return false;}}
 return async function check(){
  const url=cloudURL();if(cached&&cached.url===url&&clock()-cached.at<cacheMs)return cached.value;
  if(inflight&&inflight.url===url)return inflight.promise;
  const promise=(async()=>{const [cloud,...internet]=await Promise.all([cloudProbe(),...internetURLs.map(internetProbe)]);const value={internet:cloud||internet.some(Boolean),cloud,checkedAt:new Date(clock()).toISOString()};cached={url,at:clock(),value};return value;})();
  inflight={url,promise};try{return await promise;}finally{if(inflight?.promise===promise)inflight=null;}
 };
}
