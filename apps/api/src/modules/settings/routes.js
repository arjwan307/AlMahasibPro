import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError, asyncRoute } from '../../lib/http.js';
import { verifyPassword } from '../../lib/security.js';

const supported = store => store.transaction && store.updateOwnDisplayName && store.exportCompanyBackup;
const text = (value,max,required=false) => {
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new AppError(400,'VALIDATION_ERROR','أدخل بيانات صحيحة ضمن الحد المسموح');
  return value.trim();
};
export async function confirmSettingsOperation(store,context,body,kind) {
  const phrase = kind==='transfer' ? 'TRANSFER OWNER '+context.company.code : kind==='account' ? 'DELETE ACCOUNT '+context.user.username : (kind==='local'?'ERASE LOCAL ':'DELETE COMPANY ')+context.company.code;
  if(body.confirm!==true||body.confirmation!==phrase)throw new AppError(400,'CONFIRMATION_REQUIRED','اكتب عبارة التأكيد كاملة: '+phrase);
  const reason=text(body.reason,1000,true);
  if(typeof body.password!=='string'||body.password.length>1024)throw new AppError(400,'REAUTH_REQUIRED','أدخل كلمة مرور حسابك');
  const login=await store.findLogin({companyCode:context.company.code.toLowerCase(),username:context.user.username,platform:false});
  if(login?.user.id!==context.user.id||!await verifyPassword(body.password,login.user.passwordHash))throw new AppError(403,'REAUTH_FAILED','كلمة المرور غير صحيحة');
  return reason;
}
export function assertSettingsScope(context,permission) {
  if(!context.permissions?.includes(permission))throw new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية صريحة لهذه العملية');
  if(permission!=='account.delete'&&context.scopes?.length&&!context.scopes.some(scope=>scope.type==='company'&&scope.id===context.company.id))throw new AppError(403,'COMPANY_SCOPE_REQUIRED','يلزم نطاق الشركة كاملًا لهذه العملية');
}
export async function revalidateSettingsSession(store,context,permission) {
  const current=await store.getSessionContext(context.tokenHash);
  if(!current||current.user.id!==context.user.id||current.company?.id!==context.company.id)throw new AppError(401,'SESSION_INVALID','الجلسة منتهية أو ملغاة');
  assertSettingsScope(current,permission);
}
export async function settingsBackup(store,context,reason,kind) {
  if(!supported(store)||!store.filename)throw new AppError(501,'BACKUP_UNAVAILABLE','هذه العملية غير متاحة دون نسخة احتياطية معزولة للشركة');
  const bytes=await store.exportCompanyBackup(context.company.id);
  const directory=join(dirname(store.filename),'deletion-backups');await mkdir(directory,{recursive:true});
  const backupId=randomUUID(),filename=join(directory,backupId+'.sqlite');
  await writeFile(filename,bytes,{flag:'wx',mode:0o600});
  const check=new DatabaseSync(filename,{readOnly:true});
  try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new AppError(500,'BACKUP_INVALID','فشل التحقق من النسخة الاحتياطية');}finally{check.close();}
  await store.recordSettingsAction(context,'settings.backup.created',{backupId,reason,kind});
  return backupId;
}
export function installSettingsRoutes(app,{store,authenticate,permit,localMode=false}) {
  const session=authenticate(store);
  const tenant=(req,_res,next)=>req.auth.company&&!req.auth.user.platformAdmin?next():next(new AppError(403,'COMPANY_REQUIRED','يلزم حساب شركة'));
  const capability=(_req,_res,next)=>supported(store)?next():next(new AppError(501,'SETTINGS_UNSUPPORTED','الإعدادات الآمنة غير مدعومة في هذا المخزن'));
  app.get('/api/v1/settings',session,tenant,(req,res)=>res.json({user:req.auth.user,company:req.auth.company,permissions:req.auth.permissions,local:localMode,cloudLinked:store.cloudConnectionCompanyId===req.auth.company.id,accountDeletion:localMode&&store.cloudConnectionCompanyId!==req.auth.company.id?'local':'cloud',supported:Boolean(supported(store)),confirmation:{account:'DELETE ACCOUNT '+req.auth.user.username,company:'DELETE COMPANY '+req.auth.company.code,local:'ERASE LOCAL '+req.auth.company.code}}));
  app.patch('/api/v1/settings/profile',session,tenant,capability,asyncRoute(async(req,res)=>{
    res.json({user:await store.updateOwnDisplayName(req.auth,text(req.body.displayName,120,true))});
  }));
  app.patch('/api/v1/settings/company',session,tenant,permit('company.manage'),capability,asyncRoute(async(req,res)=>{
    res.json({company:await store.updateCompanyProfile(req.auth,{legalName:text(req.body.legalName,160,true),phone:text(req.body.phone,80),address:text(req.body.address,1000)})});
  }));
  app.post('/api/v1/settings/transfer-owner',session,tenant,permit('company.manage'),permit('users.manage'),capability,asyncRoute(async(req,res)=>{
    if(localMode&&store.cloudConnectionCompanyId===req.auth.company.id)throw new AppError(409,'CLOUD_REQUIRED','انقل الملكية في السحابة المرتبطة');
    const reason=await confirmSettingsOperation(store,req.auth,req.body,'transfer');
    res.json(await store.transaction(async()=>{await revalidateSettingsSession(store,req.auth,'company.manage');await revalidateSettingsSession(store,req.auth,'users.manage');return store.transferCompanyOwnership(req.auth,String(req.body.newOwnerId||''),reason);}));
  }));
  app.post('/api/v1/settings/delete-account',session,tenant,permit('account.delete'),capability,asyncRoute(async(req,res)=>{
    if(localMode&&store.cloudConnectionCompanyId===req.auth.company.id)throw new AppError(409,'CLOUD_REQUIRED','حذف الحساب ينفذ في السحابة؛ حذف النسخة المحلية لا يلغي الحساب السحابي');
    assertSettingsScope(req.auth,'account.delete');
    const reason=await confirmSettingsOperation(store,req.auth,req.body,'account');
    const result=await store.transaction(async()=>{await revalidateSettingsSession(store,req.auth,'account.delete');const backupId=await settingsBackup(store,req.auth,reason,'account');const result=await store.deleteOwnAccount(req.auth);await store.recordSettingsAction(req.auth,'settings.account.deleted',{reason,backupId});return {...result,backupId};});
    res.json(result);
  }));
  app.post('/api/v1/settings/delete-company',session,tenant,permit('company.delete'),capability,asyncRoute(async(req,res)=>{
    if(localMode)throw new AppError(409,'CLOUD_REQUIRED','استخدم عملية حذف الشركة السحابية المخصصة');
    assertSettingsScope(req.auth,'company.delete');
    const reason=await confirmSettingsOperation(store,req.auth,req.body,'company');
    const result=await store.transaction(async()=>{
      await revalidateSettingsSession(store,req.auth,'company.delete');
      const backupId=await settingsBackup(store,req.auth,reason,'company');
      const result=await store.deletePlatformCompany(req.auth.company.id,req.auth.user.id,{confirm:true,code:req.auth.company.code});
      await store.recordDeletionEvidence(req.auth,{reason,backupId,kind:'cloud'});return {...result,backupId};
    });
    res.json(result);
  }));
}
