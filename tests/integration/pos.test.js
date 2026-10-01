import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/lib/security.js';
import { MemoryStore } from '../../apps/api/src/store/memory-store.js';

let server;
let baseUrl;
let store;
let adminToken;
let cashierToken;
const ids = {};
const sequences = new Map();

before(async () => {
  store = new MemoryStore();
  const platform = await store.seedPlatformAdmin({ username: 'platform_pos', passwordHash: await hashPassword('Platform-Pos-123') });
  const company = await store.registerCompany({
    code: 'pos_company', legalName: 'POS Company', timezone: 'Asia/Baghdad', currency: 'IQD',
    owner: { username: 'admin', displayName: 'Admin', passwordHash: await hashPassword('Company-Pos-123') }
  });
  await store.approveCompany(company.id, platform.id);
  const app = createApp({ store });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await request('/api/v1/auth/login', { method: 'POST', body: { companyCode: 'pos_company', username: 'admin', password: 'Company-Pos-123' } })).data.token;
  await setupMasterData();
  const created = await request('/api/v1/users', {
    method: 'POST', token: adminToken,
    body: { username: 'cashier', displayName: 'Cashier', password: 'Cashier-Pos-123', roleCode: 'cashier' }
  });
  assert.equal(created.status, 201);
  cashierToken = (await request('/api/v1/auth/login', { method: 'POST', body: { companyCode: 'pos_company', username: 'cashier', password: 'Cashier-Pos-123' } })).data.token;
});

after(async () => { await new Promise((resolve) => server.close(resolve)); });

async function request(path, { token, body, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

async function create(path, body, token = adminToken) {
  const response = await request(path, { method: 'POST', token, body });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}

async function setupMasterData() {
  ids.unit = (await create('/api/v1/catalog/units', { code: 'PC', name: 'قطعة' })).unit;
  ids.item = (await create('/api/v1/catalog/items', { sku: 'POS-ITEM', name: 'مادة كاشير', baseUnitId: ids.unit.id })).item;
  await create('/api/v1/catalog/prices', { itemId: ids.item.id, unitId: ids.unit.id, priceType: 'sale', currency: 'IQD', amount: '10.000000' });
  await create('/api/v1/catalog/barcodes', { itemId: ids.item.id, unitId: ids.unit.id, barcode: 'POS0001' });
  ids.customer = (await create('/api/v1/customers', { code: 'POS-CUSTOMER', name: 'عميل آجل', creditLimit: '1000.000000' })).customer;
  ids.supplier = (await create('/api/v1/suppliers', { code: 'POS-SUPPLIER', name: 'مورد' })).supplier;
  ids.warehouse = (await create('/api/v1/warehouses', { code: 'POS-WH', name: 'مخزن الكاشير' })).warehouse;
  const purchase = {
    operationId: crypto.randomUUID(), deviceId: 'setup', clientSequence: 1, occurredAt: new Date().toISOString(),
    document: {
      documentType: 'purchase', documentNumber: 'POS-OPENING-STOCK', warehouseId: ids.warehouse.id,
      partyId: ids.supplier.id, currency: 'IQD',
      lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '100.000000', unitPrice: '5.000000' }], payments: []
    }
  };
  assert.equal((await request('/api/v1/commerce/commit', { method: 'POST', token: adminToken, body: purchase })).status, 201);
  ids.devices = {};
  for (const mode of ['restaurant', 'market', 'enterprise']) {
    const id = crypto.randomUUID();
    ids.devices[mode] = id;
    await create('/api/v1/pos/devices', {
      id, warehouseId: ids.warehouse.id, code: `POS-${mode}`, name: mode,
      interfaceMode: mode, maxDiscountPercent: '5.000000'
    });
    const allocation = await request(`/api/v1/pos/devices/${id}/allocations/${ids.item.id}`, {
      method: 'PUT', token: adminToken, body: { quantity: '20.000000' }
    });
    assert.equal(allocation.status, 200, JSON.stringify(allocation.data));
    sequences.set(id, 1);
  }
}

function operation(type, mode, payload, operationId = crypto.randomUUID()) {
  const deviceId = ids.devices[mode];
  return {
    type, operationId, deviceId, clientSequence: sequences.get(deviceId), occurredAt: new Date().toISOString(),
    payload: { ...payload, deviceId, interfaceMode: mode }
  };
}

async function send(type, mode, payload, existing) {
  const body = existing || operation(type, mode, payload);
  if (!existing) sequences.set(body.deviceId, body.clientSequence + 1);
  return { body, response: await request('/api/v1/pos/operations', { method: 'POST', token: cashierToken, body }) };
}

test('three POS interfaces open independent shifts and download barcode/allocation scope', async () => {
  ids.shifts = {};
  for (const mode of ['restaurant', 'market', 'enterprise']) {
    const bootstrap = await request(`/api/v1/pos/bootstrap?deviceId=${ids.devices[mode]}`, { token: cashierToken });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.device.interfaceMode, mode);
    assert.equal(bootstrap.data.barcodes[0].barcode, 'POS0001');
    assert.equal(bootstrap.data.allocations[0].allocatedQuantity, '20.000000');
    const shiftId = crypto.randomUUID();
    ids.shifts[mode] = shiftId;
    const opened = await send('pos.shift.open', mode, { shiftId, openingFloat: '100.000000' });
    assert.equal(opened.response.status, 201, JSON.stringify(opened.response.data));
    assert.equal(opened.response.data.result.shift.status, 'open');
  }
});

test('cash, credit and mixed POS sales use one engine and create receipts', async () => {
  const restaurant = await send('pos.sale', 'restaurant', {
    shiftId: ids.shifts.restaurant, documentNumber: 'REST-001', currency: 'IQD', partyId: null,
    lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '2.000000', unitPrice: '10.000000' }],
    payments: [{ method: 'cash', amount: '20.000000' }], discountAmount: '0.000000',
    orderContext: { serviceType: 'table', table: '4' }, offlineOrigin: true
  });
  assert.equal(restaurant.response.status, 201, JSON.stringify(restaurant.response.data));
  ids.restaurantSale = restaurant.response.data.result;
  assert.equal(ids.restaurantSale.receipt.payload.document.interfaceMode, 'restaurant');

  const enterprise = await send('pos.sale', 'enterprise', {
    shiftId: ids.shifts.enterprise, documentNumber: 'ENT-001', currency: 'IQD', partyId: ids.customer.id,
    lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '3.000000', unitPrice: '10.000000' }],
    payments: [], discountAmount: '0.000000', orderContext: { purchaseOrder: 'PO-1' }, offlineOrigin: true
  });
  assert.equal(enterprise.response.status, 201, JSON.stringify(enterprise.response.data));
  assert.equal(enterprise.response.data.result.document.dueAmount, '30.000000');

  const market = await send('pos.sale', 'market', {
    shiftId: ids.shifts.market, documentNumber: 'MKT-001', currency: 'IQD', partyId: ids.customer.id,
    lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '2.000000', unitPrice: '10.000000' }],
    payments: [{ method: 'cash', amount: '5.000000' }], discountAmount: '1.000000',
    orderContext: { lane: '1', barcode: 'POS0001' }, offlineOrigin: true
  });
  assert.equal(market.response.status, 201, JSON.stringify(market.response.data));
  assert.equal(market.response.data.result.document.grossAmount, '20.000000');
  assert.equal(market.response.data.result.document.subtotal, '19.000000');
  assert.equal(market.response.data.result.document.dueAmount, '14.000000');

  const replay = await request('/api/v1/pos/operations', { method: 'POST', token: cashierToken, body: market.body });
  assert.equal(replay.status, 201);
  assert.equal(replay.data.result.entityId, market.response.data.result.entityId);
  assert.equal([...store.commerceDocuments.values()].filter((document) => document.documentNumber === 'MKT-001').length, 1);

  const synced = operation('pos.sale', 'market', {
    shiftId: ids.shifts.market, documentNumber: 'MKT-SYNC-001', currency: 'IQD', partyId: null,
    lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '1.000000', unitPrice: '10.000000' }],
    payments: [{ method: 'cash', amount: '10.000000' }], discountAmount: '0.000000',
    orderContext: { lane: '1' }, offlineOrigin: true
  });
  sequences.set(synced.deviceId, synced.clientSequence + 1);
  const syncResponse = await request('/api/v1/sync/push', { method: 'POST', token: cashierToken, body: { operations: [synced] } });
  assert.equal(syncResponse.status, 200);
  assert.equal(syncResponse.data.results[0].status, 'acknowledged');
});

test('discount permission and device offline allocation are enforced', async () => {
  const excessiveDiscount = await send('pos.sale', 'market', {
    shiftId: ids.shifts.market, documentNumber: 'MKT-DISCOUNT-FAIL', currency: 'IQD', partyId: null,
    lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '1.000000', unitPrice: '10.000000' }],
    payments: [{ method: 'cash', amount: '8.000000' }], discountAmount: '2.000000', orderContext: {}, offlineOrigin: true
  });
  assert.equal(excessiveDiscount.response.status, 409);
  assert.equal(excessiveDiscount.response.data.result.code, 'DISCOUNT_APPROVAL_REQUIRED');

  const allocationExceeded = await send('pos.sale', 'restaurant', {
    shiftId: ids.shifts.restaurant, documentNumber: 'REST-ALLOC-FAIL', currency: 'IQD', partyId: null,
    lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '19.000000', unitPrice: '10.000000' }],
    payments: [{ method: 'cash', amount: '190.000000' }], discountAmount: '0.000000', orderContext: {}, offlineOrigin: true
  });
  assert.equal(allocationExceeded.response.status, 409);
  assert.equal(allocationExceeded.response.data.result.code, 'OFFLINE_ALLOCATION_EXCEEDED');

  const centralSale = await request('/api/v1/commerce/commit', {
    method: 'POST', token: adminToken,
    body: {
      operationId: crypto.randomUUID(), deviceId: 'central-office', clientSequence: 1, occurredAt: new Date().toISOString(),
      document: {
        documentType: 'sale', documentNumber: 'CENTRAL-RESERVED-FAIL', warehouseId: ids.warehouse.id,
        partyId: ids.customer.id, currency: 'IQD',
        lines: [{ itemId: ids.item.id, unitId: ids.unit.id, quantity: '50.000000', unitPrice: '10.000000' }], payments: []
      }
    }
  });
  assert.equal(centralSale.status, 409);
  assert.equal(centralSale.data.result.code, 'STOCK_RESERVED_FOR_OFFLINE');
});

test('POS return reverses stock/cash and closing shift settles expected cash idempotently', async () => {
  const original = ids.restaurantSale.document;
  const returned = await send('pos.return', 'restaurant', {
    shiftId: ids.shifts.restaurant, documentNumber: 'REST-RET-001', currency: 'IQD', partyId: null,
    originalDocumentId: original.id,
    lines: original.lines.map((line) => ({ itemId: line.itemId, unitId: line.unitId, originalLineId: line.id, quantity: line.quantity })),
    payments: [{ method: 'cash', amount: original.paidAmount }], orderContext: { reason: 'customer_return' }, offlineOrigin: true
  });
  assert.equal(returned.response.status, 201, JSON.stringify(returned.response.data));
  assert.equal(returned.response.data.result.document.documentType, 'sale_return');

  const closed = await send('pos.shift.close', 'restaurant', {
    shiftId: ids.shifts.restaurant, countedCash: '100.000000', submittedOffline: true
  });
  assert.equal(closed.response.status, 201, JSON.stringify(closed.response.data));
  assert.equal(closed.response.data.result.shift.status, 'closed');
  assert.equal(closed.response.data.result.shift.expectedCash, '100.000000');
  assert.equal(closed.response.data.result.shift.variance, '0.000000');
  const replay = await request('/api/v1/pos/operations', { method: 'POST', token: cashierToken, body: closed.body });
  assert.equal(replay.status, 201);
  assert.equal(replay.data.result.shift.status, 'closed');
});
