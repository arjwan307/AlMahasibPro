import { randomUUID } from 'node:crypto';
import { AppError, asyncRoute, requireFields } from '../../lib/http.js';
import { decimal, decimalString } from '../../lib/decimal.js';
import { payloadHash } from '../../lib/security.js';

const dateOnly = value => { if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(`${value}T00:00:00Z`);return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value; };
const id = value => { const text=String(value||''); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new AppError(400,'INVALID_UUID','المعرف غير صالح'); return text; };
const anyPermission = permissions => (req,res,next) => permissions.some(x=>req.auth.permissions.includes(x)) ? next() : next(new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية لهذه العملية'));

export function installPayrollRoutes(app,{store,authenticate,permit}) {
  app.get('/api/v1/hr/bootstrap',authenticate(store),anyPermission(['employees.read','employees.manage','payroll.read']),asyncRoute(async(req,res)=>res.json(await store.getHrBootstrap(req.auth))));

  app.post('/api/v1/hr/attendance/:eventType',authenticate(store),anyPermission(['attendance.record','attendance.manage']),asyncRoute(async(req,res)=>{
    if(!['check-in','check-out'].includes(req.params.eventType))throw new AppError(404,'ATTENDANCE_EVENT_NOT_FOUND','حدث الحضور غير معروف');
    requireFields(req.body,['operationId','employeeId','eventTime']);
    const eventTime=Date.parse(req.body.eventTime);if(!Number.isFinite(eventTime))throw new AppError(400,'INVALID_ATTENDANCE_TIME','وقت الحضور غير صالح');
    const operationId=id(req.body.operationId);
    const payload={eventId:operationId,employeeId:id(req.body.employeeId),eventTime:new Date(eventTime).toISOString(),source:'hr-api'};
    const operation={operationId,deviceId:'hr-api',clientSequence:Date.now(),schemaVersion:1,entityVersion:null,dependencies:[],occurredAt:payload.eventTime,type:`attendance.${req.params.eventType.replace('-','_')}`,payloadHash:payloadHash(payload),payload};
    const [result]=await store.pushOperations(req.auth,[operation]);
    if(result.status!=='acknowledged')throw new AppError(409,result.code||'ATTENDANCE_REJECTED',result.message||'تعذر تسجيل الحضور');
    res.status(201).json({attendance:result.attendance});
  }));

  app.post('/api/v1/hr/leaves',authenticate(store),anyPermission(['leaves.create','leaves.manage']),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','employeeId','leaveType','startDate','endDate']);
    const b=req.body;if(!dateOnly(b.startDate)||!dateOnly(b.endDate)||b.startDate>b.endDate)throw new AppError(400,'INVALID_LEAVE_DATES','تواريخ الإجازة غير صالحة');
    const managerEntry=req.auth.permissions.includes('leaves.manage');
    const leave=await store.createLeaveRequest(req.auth.company.id,{operationId:id(b.operationId),employeeId:id(b.employeeId),leaveType:String(b.leaveType).trim().slice(0,48),startDate:b.startDate,endDate:b.endDate,reason:String(b.reason||'').trim().slice(0,500),managerEntry},req.auth.user.id);
    res.status(201).json({leave});
  }));
  app.post('/api/v1/hr/leaves/:leaveId/decision',authenticate(store),permit('leaves.manage'),asyncRoute(async(req,res)=>{
    if(typeof req.body?.approved!=='boolean'||(req.body.approved&&typeof req.body.paid!=='boolean'))throw new AppError(400,'INVALID_LEAVE_DECISION','قرار الإجازة غير مكتمل');
    res.json({leave:await store.decideLeave(req.auth.company.id,id(req.params.leaveId),req.body.approved,req.auth.user.id,req.body.paid)});
  }));

  app.post('/api/v1/hr/overtime',authenticate(store),anyPermission(['attendance.record','attendance.manage']),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','employeeId','workDate','multiplier']);
    const b=req.body,minutes=Number(b.minutes);if(!dateOnly(b.workDate)||!Number.isInteger(minutes)||minutes<1||minutes>1440)throw new AppError(400,'INVALID_OVERTIME','بيانات العمل الإضافي غير صالحة');
    const overtime=await store.createOvertimeRequest(req.auth.company.id,{operationId:id(b.operationId),employeeId:id(b.employeeId),workDate:b.workDate,minutes,multiplier:decimalString(decimal(b.multiplier,{positive:true})),reason:String(b.reason||'').trim().slice(0,500)},req.auth.user.id);
    res.status(201).json({overtime});
  }));
  app.post('/api/v1/hr/overtime/:overtimeId/decision',authenticate(store),permit('overtime.approve'),asyncRoute(async(req,res)=>{
    if(typeof req.body?.approved!=='boolean')throw new AppError(400,'INVALID_OVERTIME_DECISION','قرار الإضافي غير صالح');
    res.json({overtime:await store.decideOvertime(req.auth.company.id,id(req.params.overtimeId),req.body.approved,req.auth.user.id)});
  }));

  app.post('/api/v1/hr/departments',authenticate(store),permit('employees.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['code','name']);
    res.status(201).json({department:await store.createDepartment(req.auth.company.id,{code:String(req.body.code).trim().toUpperCase(),name:String(req.body.name).trim().slice(0,120)},req.auth.user.id)});
  }));

  app.post('/api/v1/hr/employees',authenticate(store),permit('employees.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['code','fullName','hireDate']);
    if(!dateOnly(req.body.hireDate)) throw new AppError(400,'INVALID_HIRE_DATE','تاريخ التعيين غير صالح');
    res.status(201).json({employee:await store.createEmployee(req.auth.company.id,{code:String(req.body.code).trim().toUpperCase(),fullName:String(req.body.fullName).trim().slice(0,160),jobTitle:String(req.body.jobTitle||'').trim().slice(0,120),departmentId:req.body.departmentId?id(req.body.departmentId):null,userId:req.body.userId?id(req.body.userId):null,hireDate:req.body.hireDate},req.auth.user.id)});
  }));

  app.post('/api/v1/hr/employees/:employeeId/contracts',authenticate(store),permit('employees.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['contractNumber','startDate','basicSalary','currency']);
    if(!dateOnly(req.body.startDate)||(req.body.endDate&&!dateOnly(req.body.endDate))||(req.body.endDate&&req.body.endDate<req.body.startDate)) throw new AppError(400,'INVALID_CONTRACT_DATES','تواريخ العقد غير صالحة');
    const salary=decimalString(decimal(req.body.basicSalary,{positive:true})), currency=String(req.body.currency).toUpperCase();
    if(!['IQD','USD'].includes(currency)||currency!==req.auth.company.currency) throw new AppError(400,'DOCUMENT_CURRENCY_MISMATCH','عملة العقد يجب أن تطابق عملة حسابات الشركة');
    res.status(201).json({contract:await store.createEmployeeContract(req.auth.company.id,id(req.params.employeeId),{contractNumber:String(req.body.contractNumber).trim().slice(0,64),startDate:req.body.startDate,endDate:req.body.endDate||null,basicSalary:salary,currency},req.auth.user.id)});
  }));

  app.post('/api/v1/hr/employees/:employeeId/components',authenticate(store),permit('employees.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['code','name','componentType','amount']);
    if(!['allowance','deduction'].includes(req.body.componentType)) throw new AppError(400,'INVALID_PAY_COMPONENT','نوع مكون الراتب غير صالح');
    res.status(201).json({component:await store.addEmployeeComponent(req.auth.company.id,id(req.params.employeeId),{code:String(req.body.code).trim().toUpperCase(),name:String(req.body.name).trim().slice(0,100),componentType:req.body.componentType,amount:decimalString(decimal(req.body.amount,{nonNegative:true}))},req.auth.user.id)});
  }));

  app.post('/api/v1/hr/employees/:employeeId/advances',authenticate(store),permit('payroll.prepare'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','advanceNumber','originalAmount','installmentAmount','currency']);
    const currency=String(req.body.currency).toUpperCase();
    if(!['IQD','USD'].includes(currency)) throw new AppError(400,'INVALID_CURRENCY','عملة السلفة غير مدعومة');
    res.status(201).json({advance:await store.createEmployeeAdvance(req.auth.company.id,id(req.params.employeeId),{operationId:id(req.body.operationId),advanceNumber:String(req.body.advanceNumber).trim().slice(0,64),originalAmount:decimalString(decimal(req.body.originalAmount,{positive:true})),installmentAmount:decimalString(decimal(req.body.installmentAmount,{positive:true})),currency,grantedAt:req.body.grantedAt&&Number.isFinite(Date.parse(req.body.grantedAt))?new Date(req.body.grantedAt).toISOString():new Date().toISOString()},req.auth.user.id)});
  }));

  app.put('/api/v1/hr/payroll/settings',authenticate(store),permit('payroll.prepare'),asyncRoute(async(req,res)=>{
    const b=req.body||{}, days=Number(b.workingDaysPerMonth);
    if(!Number.isInteger(days)||days<1||days>31||typeof b.deductAbsence!=='boolean'||typeof b.attendanceRequired!=='boolean') throw new AppError(400,'INVALID_PAYROLL_SETTINGS','إعدادات الرواتب غير صالحة');
    const settings=await store.setPayrollSettings(req.auth.company.id,{workingDaysPerMonth:days,dailyHours:decimalString(decimal(b.dailyHours,{positive:true})),defaultOvertimeMultiplier:decimalString(decimal(b.defaultOvertimeMultiplier,{positive:true})),deductAbsence:b.deductAbsence,attendanceRequired:b.attendanceRequired},req.auth.user.id);
    res.json({settings});
  }));

  app.post('/api/v1/hr/payroll/cycles',authenticate(store),permit('payroll.prepare'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['cycleCode','periodStart','periodEnd','currency']);
    const b=req.body, currency=String(b.currency).toUpperCase();
    if(!dateOnly(b.periodStart)||!dateOnly(b.periodEnd)||b.periodStart>b.periodEnd) throw new AppError(400,'INVALID_PAYROLL_PERIOD','فترة الرواتب غير صالحة');
    if(currency!==req.auth.company.currency) throw new AppError(400,'DOCUMENT_CURRENCY_MISMATCH','عملة الدورة يجب أن تطابق عملة الشركة');
    const cycle=await store.createPayrollCycle(req.auth,{id:randomUUID(),cycleCode:String(b.cycleCode).trim().slice(0,64),periodStart:b.periodStart,periodEnd:b.periodEnd,currency});
    res.status(201).json({cycle});
  }));

  app.post('/api/v1/hr/payroll/cycles/:cycleId/review',authenticate(store),permit('payroll.review'),asyncRoute(async(req,res)=>res.json({cycle:await store.reviewPayrollCycle(req.auth,id(req.params.cycleId))})));
  app.post('/api/v1/hr/payroll/cycles/:cycleId/approve',authenticate(store),permit('payroll.approve'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId']);
    res.json({cycle:await store.approvePayrollCycle(req.auth,id(req.params.cycleId),id(req.body.operationId))});
  }));
  app.post('/api/v1/hr/payroll/cycles/:cycleId/pay',authenticate(store),permit('payroll.pay'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','paymentNumber']);
    const paidAt=req.body.paidAt&&Number.isFinite(Date.parse(req.body.paidAt))?new Date(req.body.paidAt).toISOString():new Date().toISOString();
    res.json({cycle:await store.payPayrollCycle(req.auth,id(req.params.cycleId),{operationId:id(req.body.operationId),paymentNumber:String(req.body.paymentNumber).trim().slice(0,64),paidAt})});
  }));
  app.post('/api/v1/hr/payroll/cycles/:cycleId/adjustments',authenticate(store),permit('payroll.adjust'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','employeeId','adjustmentNumber','adjustmentType','amount','currency','reason']);
    if(!['earning','recovery'].includes(req.body.adjustmentType)) throw new AppError(400,'INVALID_ADJUSTMENT_TYPE','نوع التسوية غير صالح');
    const currency=String(req.body.currency).toUpperCase();
    if(currency!==req.auth.company.currency) throw new AppError(400,'DOCUMENT_CURRENCY_MISMATCH','عملة التسوية يجب أن تطابق عملة الشركة');
    const occurredAt=req.body.occurredAt&&Number.isFinite(Date.parse(req.body.occurredAt))?new Date(req.body.occurredAt).toISOString():new Date().toISOString();
    res.status(201).json({adjustment:await store.adjustPayrollCycle(req.auth,id(req.params.cycleId),{operationId:id(req.body.operationId),employeeId:id(req.body.employeeId),adjustmentNumber:String(req.body.adjustmentNumber).trim().slice(0,64),adjustmentType:req.body.adjustmentType,amount:decimalString(decimal(req.body.amount,{positive:true})),currency,reason:String(req.body.reason).trim().slice(0,500),occurredAt})});
  }));
}
