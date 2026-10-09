import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEnterpriseLocal} from '../../apps/local/enterprise-server.js';
test('branch contacts persist, editing preserves identity and deletion protects linked records',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'branch-details-'));let runtime,cookie='';
 try{
 runtime=await startEnterpriseLocal({dataDirectory:directory,port:33290});
 const request=async(path,body,method=body?'POST':'GET')=>{const response=await fetch(runtime.url+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return {status:response.status,data:await response.json()};};
 await request('/api/local/setup',{legalName:'شركة',ownerName:'مدير',username:'owner',password:'Strong-Password-123'});
 await request('/api/v1/auth/login',{companyCode:'local',username:'owner',password:'Strong-Password-123'});
 const initial=await request('/api/v1/bootstrap');const main=initial.data.company.branches[0];
 assert.equal((await request('/api/v1/company/branches/'+main.id,undefined,'DELETE')).status,409);
 const body={code:'B1',name:'فرع تجريبي',managerName:'مدير الفرع',managerPhone:'07700000001',accountantName:'محاسب الفرع',accountantPhone:'07700000002',phone:'07700000003',address:'عنوان الفرع'};
 const created=await request('/api/v1/company/branches',body);assert.equal(created.status,201);const id=created.data.branch.id;
 const update=await request('/api/v1/company/branches/'+id,{name:'اسم معدل',managerPhone:'07800000001'},'PATCH');assert.equal(update.status,200);assert.equal(update.data.branch.id,id);assert.equal(update.data.branch.accountantName,body.accountantName);assert.equal(update.data.branch.address,body.address);
 assert.equal((await request('/api/v1/company/branches/'+id,{managerName:{invalid:true}},'PATCH')).status,400);
 await request('/api/v1/warehouses',{code:'W1',name:'مخزن',branchId:id});
 const linked=await request('/api/v1/company/branches/'+id,undefined,'DELETE');assert.equal(linked.status,409);assert.equal(linked.data.error.code,'BRANCH_IN_USE');
 const unused=await request('/api/v1/company/branches',{code:'EMPTY',name:'فارغ'});assert.equal((await request('/api/v1/company/branches/'+unused.data.branch.id,undefined,'DELETE')).status,200);
 await runtime.close();runtime=await startEnterpriseLocal({dataDirectory:directory,port:33290});
 const persisted=(await request('/api/v1/company/branches')).data.branches.find(x=>x.id===id);assert.equal(persisted.name,'اسم معدل');assert.equal(persisted.managerPhone,'07800000001');assert.equal(persisted.accountantPhone,body.accountantPhone);assert.equal(persisted.address,body.address);
 const ownerCookie=cookie;
 await request('/api/v1/users',{username:'reader',displayName:'قارئ',password:'Strong-Reader-123',roleCode:'accountant'});
 await request('/api/v1/auth/login',{companyCode:'local',username:'reader',password:'Strong-Reader-123'});
 assert.equal((await request('/api/v1/company/branches/'+id,{name:'غير مخول'},'PATCH')).status,403);
 assert.equal((await request('/api/v1/company/branches/'+id,undefined,'DELETE')).status,403);
 cookie=ownerCookie;
 }finally{if(runtime)await runtime.close();await rm(directory,{recursive:true,force:true});}
});
