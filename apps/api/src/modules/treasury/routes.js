import { AppError, asyncRoute, requireFields } from '../../lib/http.js';

const anyPermission = permissions => (req,res,next) => permissions.some(x=>req.auth.permissions.includes(x)) ? next() : next(new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية لهذه العملية'));
const timestamp = value => { const parsed=Date.parse(value); if(typeof value!=='string'||!Number.isFinite(parsed)) throw new AppError(400,'INVALID_DATE','التاريخ غير صالح'); return new Date(parsed).toISOString(); };

export function installTreasuryRoutes(app,{store,authenticate,permit,uuid,entityCode,decimalInput,currency}) {
  app.get('/api/v1/treasury/cashboxes',authenticate(store),anyPermission(['accounting.read','pos.shift.open','pos.shift.close']),asyncRoute(async(req,res)=>res.json({cashboxes:await store.listCashboxes(req.auth.company.id)})));
  app.post('/api/v1/treasury/cashboxes',authenticate(store),permit('accounting.post'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['code','name','currency']);
    const box=await store.createCashbox(req.auth,{code:entityCode(req.body.code),name:String(req.body.name).trim(),currency:currency(req.body.currency)});
    res.status(201).json({cashbox:box});
  }));
  app.get('/api/v1/treasury/cashboxes/:cashboxId/movements',authenticate(store),anyPermission(['accounting.read','pos.shift.close']),asyncRoute(async(req,res)=>res.json({movements:await store.listCashboxMovements(req.auth.company.id,uuid(req.params.cashboxId,'cashboxId'))})));
  app.post('/api/v1/treasury/cashboxes/:cashboxId/open',authenticate(store),anyPermission(['accounting.post','pos.shift.open']),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','sessionNumber','openingBalance']);
    const input={operationId:uuid(req.body.operationId,'operationId'),sessionNumber:entityCode(req.body.sessionNumber),openingBalance:decimalInput(req.body.openingBalance,{nonNegative:true}),openedAt:timestamp(req.body.openedAt||new Date().toISOString())};
    res.status(201).json({session:await store.openCashbox(req.auth,uuid(req.params.cashboxId,'cashboxId'),input)});
  }));
  app.post('/api/v1/treasury/cashboxes/:cashboxId/movements',authenticate(store),permit('accounting.post'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','movementNumber','direction','amount','counterAccountCode']);
    if(!['in','out'].includes(req.body.direction)) throw new AppError(400,'INVALID_CASH_DIRECTION','اتجاه الحركة غير صالح');
    const input={operationId:uuid(req.body.operationId,'operationId'),movementNumber:entityCode(req.body.movementNumber),direction:req.body.direction,amount:decimalInput(req.body.amount,{positive:true}),counterAccountCode:entityCode(req.body.counterAccountCode),reference:String(req.body.reference||'').trim().slice(0,160),note:String(req.body.note||'').trim().slice(0,500),occurredAt:timestamp(req.body.occurredAt||new Date().toISOString())};
    res.status(201).json({movement:await store.postCashboxMovement(req.auth,uuid(req.params.cashboxId,'cashboxId'),input)});
  }));
  app.post('/api/v1/treasury/cashboxes/:cashboxId/sessions/:sessionId/close',authenticate(store),anyPermission(['accounting.post','pos.shift.close']),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','countedBalance']);
    const input={operationId:uuid(req.body.operationId,'operationId'),countedBalance:decimalInput(req.body.countedBalance,{nonNegative:true}),closedAt:timestamp(req.body.closedAt||new Date().toISOString())};
    res.json({session:await store.closeCashbox(req.auth,uuid(req.params.cashboxId,'cashboxId'),uuid(req.params.sessionId,'sessionId'),input)});
  }));
}
