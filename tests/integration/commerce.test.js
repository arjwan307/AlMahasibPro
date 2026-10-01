import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/lib/security.js';
import { decimal } from '../../apps/api/src/lib/decimal.js';
import { MemoryStore } from '../../apps/api/src/store/memory-store.js';

let server;
let baseUrl;
let store;
let tokenA;
let tokenB;
const data = {};
let sequence = 1;

before(async () => {
  store = new MemoryStore();
  const platform = await store.seedPlatformAdmin({ username: 'platform', passwordHash: await hashPassword('Platform-Commerce-123') });
  for (const code of ['commerce_a', 'commerce_b']) {
    const company = await store.registerCompany({
      code, legalName: code, timezone: 'Asia/Baghdad', currency: 'IQD',
      owner: { username: 'admin', displayName: 'Admin', passwordHash: await hashPassword('Company-Commerce-123') }
    });
    await store.approveCompany(company.id, platform.id);
  }
  const app = createApp({ store });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokenA = (await request('/api/v1/auth/login', { method: 'POST', body: { companyCode: 'commerce_a', username: 'admin', password: 'Company-Commerce-123' } })).data.token;
  tokenB = (await request('/api/v1/auth/login', { method: 'POST', body: { companyCode: 'commerce_b', username: 'admin', password: 'Company-Commerce-123' } })).data.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(path, { token, body, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

async function create(path, body, token = tokenA) {
  const response = await request(path, { method: 'POST', token, body });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}

function commerceBody(document, operationId = crypto.randomUUID()) {
  return { operationId, deviceId: 'commerce-device', clientSequence: sequence++, occurredAt: '2026-10-01T12:00:00.000Z', document };
}

test('materials, units, prices, parties and warehouses remain tenant isolated', async () => {
  data.piece = (await create('/api/v1/catalog/units', { code: 'PC', name: 'قطعة', decimalPlaces: 3 })).unit;
  data.box = (await create('/api/v1/catalog/units', { code: 'BOX', name: 'علبة', decimalPlaces: 3 })).unit;
  data.item = (await create('/api/v1/catalog/items', { sku: 'ITEM-001', name: 'مادة اختبار', baseUnitId: data.piece.id })).item;
  await create(`/api/v1/catalog/items/${data.item.id}/units`, { unitId: data.box.id, conversionFactor: '12.000000' });
  await create('/api/v1/catalog/prices', { itemId: data.item.id, unitId: data.piece.id, priceType: 'sale', currency: 'IQD', amount: '15.333333' });
  data.customer = (await create('/api/v1/customers', { code: 'C-001', name: 'عميل', creditLimit: '1000.000000' })).customer;
  data.supplier = (await create('/api/v1/suppliers', { code: 'S-001', name: 'مورد' })).supplier;
  data.warehouse = (await create('/api/v1/warehouses', { code: 'MAIN', name: 'الرئيسي', kind: 'standard' })).warehouse;
  const tenantA = await request('/api/v1/master-data', { token: tokenA });
  const tenantB = await request('/api/v1/master-data', { token: tokenB });
  assert.equal(tenantA.data.items.length, 1);
  assert.equal(tenantB.data.items.length, 0);
  assert.equal(tenantB.data.customers.length, 0);
});

test('purchase posts stock, payment, balanced journal and outbox atomically with exact decimals', async () => {
  const body = commerceBody({
    documentType: 'purchase', documentNumber: 'PUR-001', warehouseId: data.warehouse.id,
    partyId: data.supplier.id, currency: 'IQD',
    lines: [{ itemId: data.item.id, unitId: data.box.id, quantity: '2.500000', unitPrice: '120.123456' }],
    payments: [{ method: 'cash', amount: '100.000000' }]
  });
  const response = await request('/api/v1/commerce/commit', { method: 'POST', token: tokenA, body });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  data.purchase = response.data.result.document;
  assert.equal(data.purchase.subtotal, '300.308640');
  assert.equal(data.purchase.dueAmount, '200.308640');
  const stock = [...store.stockBalances.values()][0];
  assert.equal(stock.quantity, '30.000000');
  assert.equal(stock.averageCost, '10.010288');
  assert.equal(store.commerceDocuments.size, 1);
  assert.equal(store.journalEntries.size, 1);
  assert.equal(store.serverOutbox.length, 1);
  for (const journal of store.journalEntries.values()) {
    assert.equal(journal.lines.reduce((sum, line) => sum + decimal(line.debit), 0n), journal.lines.reduce((sum, line) => sum + decimal(line.credit), 0n));
  }

  const replay = await request('/api/v1/commerce/commit', { method: 'POST', token: tokenA, body });
  assert.equal(replay.status, 201);
  assert.equal(replay.data.result.entityId, data.purchase.id);
  assert.equal(store.commerceDocuments.size, 1);
  assert.equal([...store.stockBalances.values()][0].quantity, '30.000000');

  const altered = structuredClone(body);
  altered.document.lines[0].quantity = '3.000000';
  const rejected = await request('/api/v1/commerce/commit', { method: 'POST', token: tokenA, body: altered });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.result.code, 'OPERATION_ID_REUSED');
});

test('sale uses precise quantity and money and a failed oversell leaves all writes untouched', async () => {
  const sale = await request('/api/v1/commerce/commit', {
    method: 'POST', token: tokenA,
    body: commerceBody({
      documentType: 'sale', documentNumber: 'SAL-001', warehouseId: data.warehouse.id,
      partyId: data.customer.id, currency: 'IQD',
      lines: [{ itemId: data.item.id, unitId: data.piece.id, quantity: '3.000000', unitPrice: '15.333333' }],
      payments: [{ method: 'cash', amount: '20.000001' }]
    })
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  data.sale = sale.data.result.document;
  assert.equal(data.sale.subtotal, '45.999999');
  assert.equal(data.sale.dueAmount, '25.999998');
  assert.equal([...store.stockBalances.values()][0].quantity, '27.000000');

  const before = {
    documents: store.commerceDocuments.size, journals: store.journalEntries.size,
    outbox: store.serverOutbox.length, quantity: [...store.stockBalances.values()][0].quantity
  };
  const failedBody = commerceBody({
    documentType: 'sale', documentNumber: 'SAL-FAIL', warehouseId: data.warehouse.id,
    partyId: data.customer.id, currency: 'IQD',
    lines: [{ itemId: data.item.id, unitId: data.piece.id, quantity: '100.000000', unitPrice: '15.333333' }], payments: []
  });
  const failed = await request('/api/v1/commerce/commit', { method: 'POST', token: tokenA, body: failedBody });
  assert.equal(failed.status, 409);
  assert.equal(failed.data.result.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual({
    documents: store.commerceDocuments.size, journals: store.journalEntries.size,
    outbox: store.serverOutbox.length, quantity: [...store.stockBalances.values()][0].quantity
  }, before);
  const retry = await request('/api/v1/commerce/commit', { method: 'POST', token: tokenA, body: failedBody });
  assert.equal(retry.data.result.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual({
    documents: store.commerceDocuments.size, journals: store.journalEntries.size,
    outbox: store.serverOutbox.length, quantity: [...store.stockBalances.values()][0].quantity
  }, before);
});

test('sale and purchase returns reference original lines and cannot exceed them', async () => {
  const saleReturn = await request('/api/v1/commerce/commit', {
    method: 'POST', token: tokenA,
    body: commerceBody({
      documentType: 'sale_return', documentNumber: 'SRET-001', warehouseId: data.warehouse.id,
      partyId: data.customer.id, originalDocumentId: data.sale.id, currency: 'IQD',
      lines: [{ itemId: data.item.id, unitId: data.piece.id, originalLineId: data.sale.lines[0].id, quantity: '1.000000' }],
      payments: [{ method: 'cash', amount: '15.333333' }]
    })
  });
  assert.equal(saleReturn.status, 201, JSON.stringify(saleReturn.data));
  assert.equal([...store.stockBalances.values()][0].quantity, '28.000000');

  const purchaseReturn = await request('/api/v1/commerce/commit', {
    method: 'POST', token: tokenA,
    body: commerceBody({
      documentType: 'purchase_return', documentNumber: 'PRET-001', warehouseId: data.warehouse.id,
      partyId: data.supplier.id, originalDocumentId: data.purchase.id, currency: 'IQD',
      lines: [{ itemId: data.item.id, unitId: data.box.id, originalLineId: data.purchase.lines[0].id, quantity: '1.000000' }], payments: []
    })
  });
  assert.equal(purchaseReturn.status, 201, JSON.stringify(purchaseReturn.data));
  assert.equal([...store.stockBalances.values()][0].quantity, '16.000000');

  const excessive = await request('/api/v1/commerce/commit', {
    method: 'POST', token: tokenA,
    body: commerceBody({
      documentType: 'sale_return', documentNumber: 'SRET-FAIL', warehouseId: data.warehouse.id,
      partyId: data.customer.id, originalDocumentId: data.sale.id, currency: 'IQD',
      lines: [{ itemId: data.item.id, unitId: data.piece.id, originalLineId: data.sale.lines[0].id, quantity: '3.000000' }], payments: []
    })
  });
  assert.equal(excessive.status, 409);
  assert.equal(excessive.data.result.code, 'RETURN_QUANTITY_EXCEEDED');
});

