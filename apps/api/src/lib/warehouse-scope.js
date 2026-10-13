import { AppError } from './http.js';

export function warehouseScopeAllows(context, warehouse) {
  if (!warehouse || warehouse.companyId !== context.company.id) return false;
  const scopes = context.scopes || [];
  const warehouses = scopes.filter(scope => scope.type === 'warehouse');
  const branches = scopes.filter(scope => scope.type === 'branch');
  return (!warehouses.length || warehouses.some(scope => scope.id === warehouse.id)) &&
    (!branches.length || branches.some(scope => scope.id === warehouse.branchId));
}

export function assertWarehouseScope(context, warehouse) {
  if (!warehouse || warehouse.companyId !== context.company.id) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'المخزن غير موجود');
  if (!warehouseScopeAllows(context, warehouse)) throw new AppError(403, 'WAREHOUSE_SCOPE_DENIED', 'المخزن خارج نطاق حسابك');
}

export function documentScopeAllows(store, context, document) {
  const branches = (context.scopes || []).filter(scope => scope.type === 'branch');
  return (!document.branchId || !branches.length || branches.some(scope => scope.id === document.branchId)) &&
    warehouseScopeAllows(context, store.warehouses.get(document.warehouseId)) &&
    (document.lines || []).every(line => warehouseScopeAllows(context, store.warehouses.get(line.warehouseId || document.warehouseId)));
}

export function assertDocumentScope(store, context, document) {
  assertWarehouseScope(context, store.warehouses.get(document.warehouseId));
  for (const line of document.lines || []) assertWarehouseScope(context, store.warehouses.get(line.warehouseId || document.warehouseId));
  const branches = (context.scopes || []).filter(scope => scope.type === 'branch');
  if (document.branchId && branches.length && !branches.some(scope => scope.id === document.branchId)) throw new AppError(403, 'BRANCH_SCOPE_DENIED', 'الفرع خارج نطاق حسابك');
}
