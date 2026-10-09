import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { AppError, asyncRoute } from './http.js';

export const commandPathAllowed = path => path === '/api/v1/sync/push' || typeof path === 'string' && /^\/api\/v1\/[a-z0-9/_?=&.%:-]+$/i.test(path) && !/^\/api\/v1\/(auth|sync|desktop|assistant|platform|companies)(\/|\?|$)/.test(path);
export function dispatchCommand(app, command, token) {
  return new Promise((resolve,reject)=>{
    const socket=new Duplex({read(){},write(chunk,encoding,done){done();}});
    socket.remoteAddress='127.0.0.1';
    const req=new IncomingMessage(socket),res=new ServerResponse(req);
    req.method=command.method;req.url=command.path;
    req.headers={authorization:'Bearer '+token,'content-type':'application/json',host:'localhost'};
    req.body=command.body;req._body=true;
    let chunks=[];
    res.write=chunk=>{chunks.push(Buffer.from(chunk));return true;};
    res.end=chunk=>{
      if(chunk)chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks).toString();
      try{resolve({status:res.statusCode,body:raw?JSON.parse(raw):null});}catch{reject(Error('العملية لا تعيد استجابة JSON قابلة للمزامنة'));}
      return res;
    };
    app.handle(req,res,error=>reject(error||Error('مسار المزامنة غير موجود')));
  });
}
export function installDesktopSync(app,{store,authenticate,permit}){
  app.post('/api/v1/desktop/commands',authenticate(store),permit('sync.use'),asyncRoute(async(req,res)=>{
    if(!store.transaction)throw new AppError(501,'TRANSACTION_REQUIRED','مزامنة الجهاز تتطلب التخزين الذري');
    const command=req.body;
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command.id||'')||!['POST','PUT','PATCH','DELETE'].includes(command.method)||!commandPathAllowed(command.path))throw new AppError(400,'INVALID_COMMAND','طلب مزامنة غير صالح');
    const key=req.auth.company.id+':'+req.auth.user.id+':'+command.id;
    const fingerprint=createHash('sha256').update(JSON.stringify({method:command.method,path:command.path,body:command.body})).digest('hex');
    const token=req.get('authorization')?.slice(7);
    if(!token)throw new AppError(401,'TOKEN_REQUIRED','الجلسة السحابية مطلوبة');
    let result;
    try{
      result=await store.transaction(async()=>{
        const previous=store.desktopCommands.get(key);
        if(previous){if(previous.fingerprint!==fingerprint)throw new AppError(409,'COMMAND_REUSED','أُعيد استخدام معرف المزامنة لطلب مختلف');return previous.result;}
        const response=await dispatchCommand(app,command,token);
        const rejected=response.body?.result?.status&&response.body.result.status!=='acknowledged'||response.body?.results?.some(x=>x.status!=='acknowledged');
        if(rejected){const failed=response.body?.result||response.body.results.find(x=>x.status!=='acknowledged');response.status=409;response.body={error:{code:failed.code||failed.error?.code||'COMMAND_REJECTED',message:failed.message||failed.error?.message||'رفض الخادم العملية'}};}
        if(response.status>=400){const error=new AppError(response.status,response.body?.error?.code||'COMMAND_REJECTED',response.body?.error?.message||'رفض الخادم العملية');error.response=response;throw error;}
        store.desktopCommands.set(key,{companyId:req.auth.company.id,userId:req.auth.user.id,id:command.id,fingerprint,result:response,createdAt:new Date().toISOString()});
        return response;
      });
    }catch(error){if(error.response)return res.status(error.response.status).json(error.response.body);throw error;}
    res.json({id:command.id,result});
  }));
}
