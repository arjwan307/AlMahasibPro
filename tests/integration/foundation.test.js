import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/lib/security.js';
import { MemoryStore } from '../../apps/api/src/store/memory-store.js';

let server;
let baseUrl;
let store;
let platformToken;
const companies = {};

before(async () => {
  store = new MemoryStore();
  await store.seedPlatformAdmin({
    username: 'platform_admin', displayName: 'مدير المنصة',
    passwordHash: await hashPassword('Platform-Strong-123')
  });
  const app = createApp({ store });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
});

async function api(path, { token, ...options } = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, headers: response.headers };
}

async function register(code) {
  const response = await api('/api/v1/companies/register', {
    method: 'POST',
    body: JSON.stringify({
      phone: '07700000000', legalName: `شركة ${code}`, ownerName: `مدير ${code}`,
      username: 'admin', password: 'Company-Strong-123', timezone: 'Asia/Baghdad', currency: 'IQD'
    })
  });
  assert.equal(response.status, 201);
  companies[code] = response.data.company;
}

async function login(companyCode, username = 'admin', password = 'Company-Strong-123') {
  return api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ companyCode: companies[companyCode]?.code || companyCode, username, password, deviceId: `test-${companyCode}` })
  });
}

test('company registration waits for platform approval', async () => {
  await register('tenant_a');
  await register('tenant_b');
  const pendingLogin = await login('tenant_a');
  assert.equal(pendingLogin.status, 403);
  assert.equal(pendingLogin.data.error.code, 'COMPANY_PENDING_APPROVAL');
});

test('platform administrator approves companies', async () => {
  const loginResponse = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ platform: true, username: 'platform_admin', password: 'Platform-Strong-123', deviceId: 'platform-test' })
  });
  assert.equal(loginResponse.status, 200);
  platformToken = loginResponse.data.token;
  const pending = await api('/api/v1/platform/companies/pending', { token: platformToken });
  assert.equal(pending.status, 200);
  assert.deepEqual(new Set(pending.data.companies.map((company) => company.code)), new Set([companies.tenant_a.code, companies.tenant_b.code]));
  for (const code of ['tenant_a', 'tenant_b']) {
    const approved = await api(`/api/v1/platform/companies/${companies[code].id}/approve`, { method: 'POST', token: platformToken });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.company.status, 'active');
  }
});

test('sessions are server-side and tenant context cannot be selected by the client', async () => {
  const alpha = await login('tenant_a');
  const beta = await login('tenant_b');
  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 200);
  assert.match(alpha.headers.get('set-cookie'), /HttpOnly/);
  const alphaBootstrap = await api('/api/v1/bootstrap', { token: alpha.data.token });
  const betaBootstrap = await api('/api/v1/bootstrap', { token: beta.data.token });
  assert.equal(alphaBootstrap.data.company.code, companies.tenant_a.code);
  assert.equal(betaBootstrap.data.company.code, companies.tenant_b.code);
  assert.notEqual(alphaBootstrap.data.company.id, betaBootstrap.data.company.id);
  assert.ok(alphaBootstrap.data.permissions.includes('users.manage'));
});

test('role permissions deny company administration to a cashier', async () => {
  const admin = await login('tenant_a');
  const created = await api('/api/v1/users', {
    method: 'POST', token: admin.data.token,
    body: JSON.stringify({ username: 'cashier1', displayName: 'كاشير أول', password: 'Cashier-Strong-123', roleCode: 'cashier' })
  });
  assert.equal(created.status, 201);
  const cashier = await login('tenant_a', 'cashier1', 'Cashier-Strong-123');
  assert.equal(cashier.status, 200);
  const roles = await api('/api/v1/roles', { token: cashier.data.token });
  assert.equal(roles.status, 403);
  assert.equal(roles.data.error.code, 'PERMISSION_DENIED');
});

test('sync is idempotent, immutable and isolated between companies', async () => {
  const alpha = await login('tenant_a');
  const beta = await login('tenant_b');
  const operationId = crypto.randomUUID();
  const operation = {
    operationId, deviceId: 'test-tenant_a', clientSequence: 1, schemaVersion: 1,
    occurredAt: new Date().toISOString(), type: 'financial.record',
    payload: { kind: 'opening_receipt', amount: '1250.000000', currency: 'IQD', companyId: companies.tenant_b.id }
  };
  const first = await api('/api/v1/sync/push', {
    method: 'POST', token: alpha.data.token, body: JSON.stringify({ operations: [operation] })
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.results[0].status, 'acknowledged');
  const entityId = first.data.results[0].entityId;

  const replay = await api('/api/v1/sync/push', {
    method: 'POST', token: alpha.data.token, body: JSON.stringify({ operations: [operation] })
  });
  assert.equal(replay.data.results[0].entityId, entityId);
  assert.equal(store.financialRecords.size, 1);

  const changedReplay = structuredClone(operation);
  changedReplay.payload.amount = '9999.000000';
  const rejected = await api('/api/v1/sync/push', {
    method: 'POST', token: alpha.data.token, body: JSON.stringify({ operations: [changedReplay] })
  });
  assert.equal(rejected.data.results[0].code, 'OPERATION_ID_REUSED');
  assert.equal(store.financialRecords.size, 1);

  const alphaPull = await api('/api/v1/sync/pull?cursor=0', { token: alpha.data.token });
  const betaPull = await api('/api/v1/sync/pull?cursor=0', { token: beta.data.token });
  assert.ok(alphaPull.data.changes.some((change) => change.entityId === entityId));
  assert.ok(!betaPull.data.changes.some((change) => change.entityId === entityId));
  assert.equal([...store.financialRecords.values()][0].companyId, companies.tenant_a.id);
});

test('logout revokes the server session', async () => {
  const session = await login('tenant_a');
  const logout = await api('/api/v1/auth/logout', { method: 'POST', token: session.data.token });
  assert.equal(logout.status, 204);
  const bootstrap = await api('/api/v1/bootstrap', { token: session.data.token });
  assert.equal(bootstrap.status, 401);
});

