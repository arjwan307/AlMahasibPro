import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';
import {imageData,invoiceAttachment} from '../../apps/api/src/lib/company-media.js';

test('company invoice design and product image persist and require management permission',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'company-media-'));let runtime,cookie='';
 try{
  runtime=await startEnterpriseLocal({dataDirectory:directory,port:33291});
  const request=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(runtime.url+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const next=r.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return {status:r.status,data:await r.json()};};
  await request('/api/local/setup',{legalName:'شركة',ownerName:'مدير',username:'owner',password:'Strong-Password-123'});
  await request('/api/v1/auth/login',{companyCode:'local',username:'owner',password:'Strong-Password-123'});
  const unit=(await request('/api/v1/catalog/units',{code:'PCS',name:'قطعة',decimalPlaces:0})).data.unit;
  const item=(await request('/api/v1/catalog/items',{sku:'I1',name:'بضاعة',baseUnitId:unit.id})).data.item;
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7M0AAAAASUVORK5CYII=';
  assert.equal((await request('/api/v1/catalog/items/'+item.id+'/image',{image},'PUT')).status,200);
  assert.equal((await request('/api/v1/catalog/items/'+item.id+'/image',{image:'data:image/png;base64,PHNjcmlwdD4='},'PUT')).status,400);
  const design={heading:'فاتورة',address:'بغداد',phone:'07800000000',footer:'شكرًا',color:'#126b65',layout:'modern',showImages:true,logo:image};
  assert.equal((await request('/api/v1/company/invoice-design',design,'PUT')).status,200);
  assert.equal((await request('/api/v1/company/invoice-design',{...design,color:'red;display:none'},'PUT')).status,400);
  const attachment={name:'نموذج.pdf',data:'data:application/pdf;base64,'+Buffer.from('%PDF-1.4\n%%EOF').toString('base64')};
  assert.equal((await request('/api/v1/company/invoice-reference',attachment,'PUT')).status,200);
  await runtime.close();runtime=await startEnterpriseLocal({dataDirectory:directory,port:33291});
  assert.equal((await request('/api/v1/company/invoice-design')).data.design.logo,image);
  assert.equal((await request('/api/v1/catalog/items/'+item.id+'/details')).data.item.image,image);
  assert.equal((await request('/api/v1/company/invoice-reference')).data.attachment.name,attachment.name);
  await request('/api/v1/users',{username:'reader',displayName:'قارئ',password:'Strong-Reader-123',roleCode:'accountant'});
  await request('/api/v1/auth/login',{companyCode:'local',username:'reader',password:'Strong-Reader-123'});
  assert.equal((await request('/api/v1/company/invoice-design',design,'PUT')).status,403);
  assert.equal((await request('/api/v1/catalog/items/'+item.id+'/image',{image},'PUT')).status,403);
  assert.equal((await request('/api/v1/company/invoice-reference')).status,403);
 }finally{if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});

test('uploaded references reject scripts, unsupported images and oversized data',()=>{
 assert.throws(()=>imageData('data:image/svg+xml;base64,PHN2Zz4='));
 assert.throws(()=>invoiceAttachment({name:'x.pdf',data:'data:application/pdf;base64,PHNjcmlwdD4='}));
 assert.throws(()=>invoiceAttachment({name:'x.png',data:'a'.repeat(2800001)}));
});
