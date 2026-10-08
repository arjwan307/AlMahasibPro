import { AppError, asyncRoute, requireFields } from '../../lib/http.js';

const anyPermission = permissions => (req,res,next) => permissions.some(x=>req.auth.permissions.includes(x)) ? next() : next(new AppError(403,'PERMISSION_DENIED','لا توجد صلاحية لهذه العملية'));
const timestamp = value => { const parsed=Date.parse(value); if(typeof value!=='string'||!Number.isFinite(parsed)) throw new AppError(400,'INVALID_DATE','التاريخ غير صالح'); return new Date(parsed).toISOString(); };

export function installImportRoutes(app,{store,authenticate,permit,uuid,entityCode,decimalInput,currency,warehouseScopeAllows}) {
  const assertShipmentScope=(req,shipment)=>{
    if(!shipment||shipment.companyId!==req.auth.company.id)throw new AppError(404,'SHIPMENT_NOT_FOUND','الشحنة غير موجودة');
    if(!(req.auth.scopes||[]).some(scope=>['branch','warehouse'].includes(scope.type)))return;
    const document=shipment.purchaseDocumentId&&store.commerceDocuments.get(shipment.purchaseDocumentId);
    if(document&&warehouseScopeAllows(req.auth,store.warehouses.get(document.warehouseId)))return;
    if(!document&&shipment.createdBy===req.auth.user.id)return;
    throw new AppError(403,'WAREHOUSE_SCOPE_DENIED','الشحنة خارج نطاق حسابك');
  };
  app.get('/api/v1/import/shipments',authenticate(store),anyPermission(['imports.read','imports.manage']),asyncRoute(async(req,res)=>{const shipments=await store.listImportShipments(req.auth.company.id);res.json({shipments:shipments.filter(shipment=>{try{assertShipmentScope(req,shipment);return true;}catch{return false;}})});}));
  app.post('/api/v1/import/shipments',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','shipmentNumber','containerNumber','supplierId','currency']);
    const shipment=await store.createImportShipment(req.auth,{operationId:uuid(req.body.operationId,'operationId'),shipmentNumber:entityCode(req.body.shipmentNumber),containerNumber:String(req.body.containerNumber).trim().slice(0,80),supplierId:uuid(req.body.supplierId,'supplierId'),currency:currency(req.body.currency),origin:String(req.body.origin||'').trim().slice(0,120),billOfLading:String(req.body.billOfLading||'').trim().slice(0,120),shippedAt:req.body.shippedAt?timestamp(req.body.shippedAt):null,expectedAt:req.body.expectedAt?timestamp(req.body.expectedAt):null});
    res.status(201).json({shipment});
  }));
  app.post('/api/v1/import/shipments/:shipmentId/arrival',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','arrivedAt']);
    assertShipmentScope(req,store.importShipments.get(uuid(req.params.shipmentId,'shipmentId')));
    res.json({shipment:await store.markImportShipmentArrived(req.auth,uuid(req.params.shipmentId,'shipmentId'),{operationId:uuid(req.body.operationId,'operationId'),arrivedAt:timestamp(req.body.arrivedAt)})});
  }));
  app.post('/api/v1/import/shipments/:shipmentId/purchase-document',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','purchaseDocumentId']);
    const shipment=store.importShipments.get(uuid(req.params.shipmentId,'shipmentId'));assertShipmentScope(req,shipment);
    const purchaseDocument=store.commerceDocuments.get(uuid(req.body.purchaseDocumentId,'purchaseDocumentId'));
    if(purchaseDocument&&!warehouseScopeAllows(req.auth,store.warehouses.get(purchaseDocument.warehouseId)))throw new AppError(403,'WAREHOUSE_SCOPE_DENIED','فاتورة الشراء خارج نطاق حسابك');
    res.json({shipment:await store.linkImportPurchaseDocument(req.auth,uuid(req.params.shipmentId,'shipmentId'),{operationId:uuid(req.body.operationId,'operationId'),purchaseDocumentId:uuid(req.body.purchaseDocumentId,'purchaseDocumentId')})});
  }));
  app.post('/api/v1/import/shipments/:shipmentId/costs',authenticate(store),permit('imports.manage'),asyncRoute(async(req,res)=>{
    requireFields(req.body,['operationId','currency']);
    assertShipmentScope(req,store.importShipments.get(uuid(req.params.shipmentId,'shipmentId')));
    if(!Array.isArray(req.body.charges)||!req.body.charges.length||req.body.charges.length>50||!Array.isArray(req.body.allocations)||!req.body.allocations.length||req.body.allocations.length>500) throw new AppError(400,'INVALID_IMPORT_COSTS','بنود التكاليف والتوزيع غير صالحة');
    const charges=req.body.charges.map((charge,index)=>{
      const code=String(charge.code||'').trim().toLowerCase();
      if(!['freight','customs','insurance','handling','other'].includes(code))throw new AppError(400,'INVALID_IMPORT_CHARGE','نوع تكلفة الشحن غير صالح');
      return{code,description:String(charge.description||'').trim().slice(0,160),amount:decimalInput(charge.amount,{positive:true})};
    });
    const allocations=req.body.allocations.map(line=>({itemId:uuid(line.itemId,'itemId'),amount:decimalInput(line.amount,{positive:true})}));
    if(new Set(allocations.map(x=>x.itemId)).size!==allocations.length)throw new AppError(400,'DUPLICATE_IMPORT_ALLOCATION','لا تكرر المادة في التوزيع');
    const cost=await store.postImportCosts(req.auth,uuid(req.params.shipmentId,'shipmentId'),{operationId:uuid(req.body.operationId,'operationId'),currency:currency(req.body.currency),charges,allocations,occurredAt:timestamp(req.body.occurredAt||new Date().toISOString())});
    res.status(201).json({cost});
  }));
}
