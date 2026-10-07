import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/lib/security.js';
import { MemoryStore } from '../../apps/api/src/store/memory-store.js';

let server, baseUrl, store, adminToken, representativeToken, managerToken, generalManagerToken;
let item, unit, warehouse, customer;
let sequence = 1;

before(async () => {
  store = new MemoryStore();
  const platform = await store.seedPlatformAdmin({ username: 'platform', passwordHash: await hashPassword('Platform-Wholesale-123') });
  const company = await store.registerCompany({
    code: 'wholesale_test', legalName: 'شركة الاختبار', timezone: 'Asia/Baghdad', currency: 'IQD',
    owner: { username: 'admin', displayName: 'مدير الشركة', passwordHash: await hashPassword('Company-Wholesale-123') }
  });
  await store.approveCompany(company.id, platform.id);
  for (const [username, roleCode] of [
    ['rep', 'wholesale_representative'], ['sales_manager', 'wholesale_manager'], ['general', 'general_manager']
  ]) {
    await store.createUser(company.id, {
      username, displayName: username, passwordHash: await hashPassword('Role-Wholesale-123'), roleCode
    }, company.ownerUserId);
  }
  const app = createApp({ store });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await login('admin')).token;
  representativeToken = (await login('rep')).token;
  managerToken = (await login('sales_manager')).token;
  generalManagerToken = (await login('general')).token;

  unit = (await create('/api/v1/catalog/units', { code: 'PC', name: 'قطعة', decimalPlaces: 0 })).unit;
  item = (await create('/api/v1/catalog/items', { sku: 'ITEM-001', name: 'صنف اختبار', baseUnitId: unit.id })).item;
  warehouse = (await create('/api/v1/warehouses', { code: 'MAIN', name: 'مخزن المحافظة الثانية' })).warehouse;
  customer = (await create('/api/v1/customers', {
    code: 'C-001', name: 'عميل الاختبار', phone: '07700000000', province: 'نينوى', district: 'الموصل', creditLimit: '1000'
  })).customer;
  await request('/api/v1/commerce/commit', {
    method: 'POST', token: adminToken,
    body: commerceBody({
      documentType: 'purchase', documentNumber: 'PUR-001', warehouseId: warehouse.id, partyId: null, currency: 'IQD',
      lines: [{ itemId: item.id, unitId: unit.id, quantity: '10', unitPrice: '1' }], payments: []
    })
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function login(username) {
  const response = await request('/api/v1/auth/login', {
    method: 'POST', body: { companyCode: 'wholesale_test', username, password: username === 'admin' ? 'Company-Wholesale-123' : 'Role-Wholesale-123' }
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function request(path, { token, body, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
async function create(path, body) {
  const result = await request(path, { method: 'POST', token: adminToken, body });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
function commerceBody(document) {
  return { operationId: crypto.randomUUID(), deviceId: 'test-device', clientSequence: sequence++, occurredAt: new Date().toISOString(), document };
}
function stock() { return [...store.stockBalances.values()].find((x) => x.warehouseId === warehouse.id && x.itemId === item.id)?.quantity; }

test('draft, manager escalation, final approval and internal notes keep the stock boundary', async () => {
  const created = await request('/api/v1/wholesale/invoices', {
    method: 'POST', token: representativeToken,
    body: {
      representativeType: 'wholesale', customerId: customer.id, warehouseId: warehouse.id, currency: 'IQD',
      paymentType: 'credit', paidAmount: '0', discountAmount: '1', internalNote: 'ملاحظة داخلية',
      lines: [{ itemId: item.id, unitId: unit.id, quantity: '2', unitPrice: '5' }]
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const invoice = created.data.invoice;
  assert.equal(invoice.invoiceNumber, 'WH-000001');
  assert.equal(invoice.customerProvince, 'نينوى');
  assert.equal(invoice.total, '9.000000');
  assert.equal(stock(), '10.000000');

  const forward = await request(`/api/v1/wholesale/invoices/${invoice.id}/decision`, {
    method: 'POST', token: managerToken, body: { action: 'forward', note: 'مراجعة السعر قبل الإرسال' }
  });
  assert.equal(forward.status, 200, JSON.stringify(forward.data));
  assert.equal(forward.data.invoice.status, 'pending_general_manager');
  assert.equal(stock(), '10.000000');

  const approved = await request(`/api/v1/wholesale/invoices/${invoice.id}/decision`, {
    method: 'POST', token: generalManagerToken, body: { action: 'approve' }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.invoice.status, 'approved');
  assert.equal(approved.data.invoice.postedDocumentId != null, true);
  assert.equal(stock(), '8.000000');
  const sale = [...store.commerceDocuments.values()].find((x) => x.documentNumber === invoice.invoiceNumber);
  assert.equal(sale.subtotal, '9.000000');
  assert.equal(Object.hasOwn(sale, 'notes'), false);
  assert.equal(approved.data.invoice.notes.length, 2);
});

test('invoice design is company scoped and saved through the draft event stream', async () => {
  const saved = await request('/api/v1/wholesale/settings', {
    method: 'POST', token: adminToken,
    body: { template: 'modern', commercialName: 'تجربة', logo: '', address: 'بغداد', phone: '0770', registration: '', signatory: '', footer: 'شكرًا' }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const fetched = await request('/api/v1/wholesale/settings', { token: representativeToken });
  assert.equal(fetched.data.settings.template, 'modern');
  assert.equal(fetched.data.settings.commercialName, 'تجربة');
});

