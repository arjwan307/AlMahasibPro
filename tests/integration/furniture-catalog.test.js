import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseCloud} from '../../apps/api/src/cloud-server.js';
import {furnitureCatalog} from '../../apps/api/src/furniture-catalog.js';
test('furniture catalogue imports once, counts components, supports categories/description/deletion and persists',async()=>{
 const catalog=furnitureCatalog();assert.equal(catalog.items.length,252);for(const i of catalog.items.filter(x=>x.metadata.components.length))assert.equal(i.metadata.components.reduce((s,x)=>s+x.quantity,0),i.metadata.pieces);const models=Map.groupBy(catalog.items,x=>x.metadata.modelCode);for(const rows of models.values())assert.equal(rows.length,3);
 const dir=await mkdtemp(join(tmpdir(),'furniture-'));let rt;const key='furniture-test-setup-key-123456789';let cookie='';
 try{
 rt=await startEnterpriseCloud({dataDirectory:dir,setupToken:key,origin:'https://example.test',port:0});
 const req=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(rt.url+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 assert.equal((await req('/api/local/setup',{setupToken:key,legalName:'أثاث تجريبي',ownerName:'مدير',username:'admin',password:'Strong-Password-123'})).status,201);
 cookie=(await req('/api/v1/auth/login',{companyCode:'company',username:'admin',password:'Strong-Password-123'})).cookie;
 await rt.close();await writeFile(join(dir,'furniture-catalog-request.json'),JSON.stringify({companyCode:'company',catalog:'furniture-v1'}));rt=await startEnterpriseCloud({dataDirectory:dir,setupToken:key,origin:'https://example.test',port:0});
 const result=JSON.parse(await readFile(join(dir,'furniture-catalog-result.json'),'utf8'));assert.equal(result.itemsCreated,252);assert.equal(result.warehousesCreated,5);assert.equal(result.pricesCreated,504);
 let m=(await req('/api/v1/master-data')).data;assert.equal(m.items.length,252);assert.equal(m.categories.length,6);const life=m.items.filter(x=>x.name.includes('حياة'));assert.equal(life.length,3);assert.deepEqual(life.map(i=>Number(m.stock.find(x=>x.itemId===i.id).quantity)),[20,20,20]);assert(m.stock.filter(x=>!life.some(i=>i.id===x.itemId)).every(x=>Number(x.quantity)>0));
 assert.equal((await req('/api/v1/catalog/categories',{name:'ديكور'})).status,201);assert.equal((await req('/api/v1/catalog/categories',{name:'ديكور'})).status,409);
 const item=m.items[0];const details=(await req('/api/v1/catalog/items/'+item.id+'/details')).data.item;assert.equal(details.components.length,5);assert.equal(details.pieces,5);assert.equal((await req('/api/v1/sales/settings/item/'+item.id,{channel:'both',movement:'strong',maxDiscountPercent:'3'},'PUT')).status,200);assert.equal((await req('/api/v1/catalog/items/'+item.id+'/details')).data.item.components.length,5);
 assert.equal((await req('/api/v1/catalog/items/'+item.id,{description:'وصف معدّل'},'PATCH')).status,200);
 assert.equal((await req('/api/v1/catalog/items/'+item.id,undefined,'DELETE')).status,200);assert.equal((await req('/api/v1/catalog/items/'+item.id+'/details')).status,404);
 await rt.close();rt=await startEnterpriseCloud({dataDirectory:dir,setupToken:key,origin:'https://example.test',port:0});m=(await req('/api/v1/master-data')).data;assert.equal(m.items.length,251);assert(m.categories.includes('ديكور'));assert.equal(m.prices.length,502);
 }finally{await rt?.close();await rm(dir,{recursive:true,force:true});}
});
