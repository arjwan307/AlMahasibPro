import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/lib/security.js';
import { MemoryStore } from '../../apps/api/src/store/memory-store.js';
import { SQLiteStore } from '../../apps/api/src/store/sqlite-store.js';
import { deleteTenantEverywhere, retryTenantDeletion } from '../../apps/api/src/lib/tenant-deletion.js';

let server;
let baseUrl;
let store;
let platformToken;
let testDirectory;

const PASSWORD = 'Company-Strong-123';
const companies = {};

before(async () => {
  testDirectory=await mkdtemp(join(tmpdir(),'platform-delete-'));
  store = new SQLiteStore(join(testDirectory,'state.sqlite'));
  await store.seedPlatformAdmin({ username: 'platform_admin', displayName: 'Platform', passwordHash: await hashPassword('Platform-Strong-123') });
  const app = createApp({ store });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ platform: true, username: 'platform_admin', password: 'Platform-Strong-123', deviceId: 'platform' }) });
  assert.equal(login.status, 200);
  platformToken = login.data.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await rm(testDirectory,{recursive:true,force:true});
});

async function api(path, { token, cookies, ...options } = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookies) headers.Cookie = cookies;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, data, cookie: response.headers.get('set-cookie') };
}

async function registerCompany(username) {
  const response = await api('/api/v1/companies/register', {
    method: 'POST',
    body: JSON.stringify({ phone: '07700000000', legalName: `Company ${username}`, ownerName: `Owner ${username}`, username, password: PASSWORD, timezone: 'Asia/Baghdad', currency: 'IQD' })
  });
  assert.equal(response.status, 201);
  return response.data.company;
}

async function approveCompany(companyId, code) {
  const response = await api(`/api/v1/platform/companies/${companyId}/approve`, { token: platformToken, method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(response.status, 200);
  return response.data.company;
}

async function loginCompany(companyCode, username) {
  return api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ companyCode, username, password: PASSWORD, deviceId: `test-${username}` }) });
}

test('platform approves two independent companies', async () => {
  const a = await registerCompany('owner_a');
  const b = await registerCompany('owner_b');
  companies.a = await approveCompany(a.id, 'co1001');
  companies.b = await approveCompany(b.id, 'co1002');
  assert.equal(companies.a.code, 'co1001');
  assert.equal(companies.b.code, 'co1002');
  assert.notEqual(companies.a.id, companies.b.id);
});

test('developer and company sessions stay isolated in the same browser', async () => {
  const companyLogin = await loginCompany(companies.a.code, 'owner_a');
  assert.equal(companyLogin.status, 200);
  assert.match(companyLogin.cookie, /^almahasib_session=/);
  assert.doesNotMatch(companyLogin.cookie, /_dev=/);
  const companyCookie = companyLogin.cookie.split(';')[0];

  const platformLogin = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ platform: true, username: 'platform_admin', password: 'Platform-Strong-123', deviceId: 'platform' }) });
  assert.equal(platformLogin.status, 200);
  assert.match(platformLogin.cookie, /^almahasib_session_dev=/);
  const developerCookie = platformLogin.cookie.split(';')[0];

  const both = `${companyCookie}; ${developerCookie}`;
  const platformRoute = await api('/api/v1/platform/companies', { cookies: both });
  assert.equal(platformRoute.status, 200);
  assert.ok(platformRoute.data.companies.some((company) => company.id === companies.a.id));

  const companyRoute = await api('/api/v1/bootstrap', { cookies: both });
  assert.equal(companyRoute.status, 200);
  assert.equal(companyRoute.data.company.id, companies.a.id);

  const logout = await api('/api/v1/auth/logout', { cookies: both, method: 'POST', body: '{}' });
  assert.equal(logout.status, 204);
  assert.match(logout.cookie, /^almahasib_session=/);
  assert.doesNotMatch(logout.cookie, /_dev=/);

  const stillDeveloper = await api('/api/v1/platform/companies', { cookies: developerCookie });
  assert.equal(stillDeveloper.status, 200);
  const revokedCompany = await api('/api/v1/bootstrap', { cookies: companyCookie });
  assert.equal(revokedCompany.status, 401);
});

test('deletion confirmation is enforced before any purge', async () => {
  const noConfirm = await api(`/api/v1/platform/companies/${companies.a.id}`, { token: platformToken, method: 'DELETE', body: JSON.stringify({ code: 'co1001' }) });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.data.error.code, 'CONFIRMATION_REQUIRED');
  const wrongCode = await api(`/api/v1/platform/companies/${companies.a.id}`, { token: platformToken, method: 'DELETE', body: JSON.stringify({ confirm: true, code: 'nope' }) });
  assert.equal(wrongCode.status, 400);
  assert.equal(store.companies.has(companies.a.id), true);
});

test('company deletion purges every tenant-scoped record and preserves others', async () => {
  const aId = companies.a.id;
  const bId = companies.b.id;
  const aUser = [...store.users.values()].find((user) => user.companyId === aId);
  const bUser = [...store.users.values()].find((user) => user.companyId === bId);
  store.warehouses.set('wh-a', { id: 'wh-a', companyId: aId, name: 'A warehouse' });
  store.warehouses.set('wh-b', { id: 'wh-b', companyId: bId, name: 'B warehouse' });
  store.stockBalances.set(`${aId}:wh-a:i1`, { companyId: aId, warehouseId: 'wh-a', itemId: 'i1', quantity: '5' });
  store.stockBalances.set(`${bId}:wh-b:i1`, { companyId: bId, warehouseId: 'wh-b', itemId: 'i1', quantity: '9' });
  store.operations.set(`${aId}:op-a`, { companyId: aId, operationId: 'op-a' });
  store.operations.set(`${bId}:op-b`, { companyId: bId, operationId: 'op-b' });
  store.changes.push({ companyId: aId, entityType: 'test' }, { companyId: bId, entityType: 'test' });
  store.audit.push({ companyId: aId, action: 'test' }, { companyId: bId, action: 'test' });
  store.serverOutbox.push({ companyId: aId }, { companyId: bId });
  store.salesSettings.set(`invoice-design:${aId}`, { companyId: aId });
  store.salesSettings.set(`invoice-design:${bId}`, { companyId: bId });
  store.salesSettings.set(`user:${aUser.id}`, { theme: 'dark' });
  store.salesSettings.set(`user:${bUser.id}`, { theme: 'light' });
  await store.createSession({ tokenHash: 'hash-a', userId: aUser.id, deviceId: 'a', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  await store.createSession({ tokenHash: 'hash-b', userId: bUser.id, deviceId: 'b', expiresAt: new Date(Date.now() + 86400000).toISOString() });

  const response = await api(`/api/v1/platform/companies/${aId}`, { token: platformToken, method: 'DELETE', body: JSON.stringify({ confirm: true, code: 'co1001' }) });
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'completed');
  assert.equal(response.data.generation >= 1, true);

  assert.equal(store.companies.has(aId), false);
  assert.equal(store.companies.has(bId), true);
  assert.equal(store.roles.has([...store.roles.values()].find((role) => role.companyId === aId)?.id || '__none__'), false);
  for (const user of store.users.values()) assert.notEqual(user.companyId, aId);
  for (const session of store.sessions.values()) assert.notEqual(session.userId, aUser.id);
  assert.equal([...store.sessions.values()].some((session) => session.userId === bUser.id), true);
  assert.equal(store.warehouses.has('wh-a'), false);
  assert.equal(store.warehouses.has('wh-b'), true);
  assert.equal(store.stockBalances.has(`${aId}:wh-a:i1`), false);
  assert.equal(store.stockBalances.has(`${bId}:wh-b:i1`), true);
  assert.equal(store.operations.has(`${aId}:op-a`), false);
  assert.equal(store.operations.has(`${bId}:op-b`), true);
  assert.equal(store.changes.some((row) => row.companyId === aId), false);
  assert.equal(store.changes.some((row) => row.companyId === bId), true);
  assert.equal(store.audit.some((row) => row.companyId === aId && row.action === 'test'), false);
  assert.equal(store.audit.some((row) => row.companyId === bId && row.action === 'test'), true);
  assert.equal(store.serverOutbox.some((row) => row.companyId === aId), false);
  assert.equal(store.serverOutbox.some((row) => row.companyId === bId), true);
  assert.equal(store.salesSettings.has(`invoice-design:${aId}`), false);
  assert.equal(store.salesSettings.has(`invoice-design:${bId}`), true);
  assert.equal(store.salesSettings.has(`user:${aUser.id}`), false);
  assert.equal(store.salesSettings.has(`user:${bUser.id}`), true);
  assert.equal(store.deletedCompanies.has(aId), true);
  assert.equal(store.deletedCompanies.has(bId), false);
  assert.ok([...store.users.values()].some((user) => user.platformAdmin));
});

test('deletion is idempotent, blocks stale sync and allows code reuse', async () => {
  const aId = companies.a.id;
  const deleted = await api(`/api/v1/platform/companies/${aId}`, { token: platformToken, method: 'DELETE', body: JSON.stringify({ confirm: true, code: 'co1001' }) });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.alreadyDeleted, true);

  const notice = await api(`/api/v1/company/deletion-notice?companyId=${aId}`);
  assert.equal(notice.status, 200);
  assert.equal(notice.data.deleted, true);

  await assert.rejects(
    store.pushOperations({ company: { id: aId }, user: { id: 'x' }, permissions: [] }, [{ operationId: '11111111-1111-4111-8111-111111111111', clientSequence: 1, type: 'draft.upsert', payload: {} }]),
    (error) => error.code === 'COMPANY_DELETED'
  );

  const reused = await registerCompany('owner_c');
  const approved = await approveCompany(reused.id, 'co1001');
  assert.equal(approved.code, 'co1001');

  const companyLogin = await loginCompany('co1001', 'owner_c');
  assert.equal(companyLogin.status, 200);
  const bootstrap = await api('/api/v1/bootstrap', { cookies: companyLogin.cookie.split(';')[0] });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.company.id, reused.id);
});

test('company B still works after A is deleted', async () => {
  const login = await loginCompany(companies.b.code, 'owner_b');
  assert.equal(login.status, 200);
  const bootstrap = await api('/api/v1/bootstrap', { cookies: login.cookie.split(';')[0] });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.company.id, companies.b.id);
});

test('deletion survives a SQLite restart and cannot be resurrected by an old snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenant-delete-'));
  const filename = join(directory, 'state.sqlite');
  try {
    const first = new SQLiteStore(filename);
    await first.seedPlatformAdmin({ username: 'root', displayName: 'Root', passwordHash: await hashPassword('Platform-Strong-123') });
    const adminId = [...first.users.values()].find((user) => user.platformAdmin).id;
    const company = await first.registerCompany({ code: 'co2001', legalName: 'Persist Co', timezone: 'Asia/Baghdad', currency: 'IQD', phone: '0770', address: '', owner: { displayName: 'Owner', username: 'owner_p', passwordHash: await hashPassword(PASSWORD) } });
    await first.approveCompany(company.id, adminId, 'co2001');
    await first.deletePlatformCompany(company.id, adminId, { confirm: true, code: 'co2001' });
    assert.equal(first.isCompanyTombstoned(company.id), true);
    await first.close();

    const second = new SQLiteStore(filename);
    assert.equal(second.companies.has(company.id), false);
    assert.equal(second.isCompanyTombstoned(company.id), true);
    await assert.rejects(second.importCloudSnapshot(Buffer.from('not-a-database'), company.id));
    assert.equal(second.companies.has(company.id), false);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

test('coordinated deletion retries idempotently after a transport failure', async () => {
  const cloud = new MemoryStore();
  await cloud.seedPlatformAdmin({ username: 'root', displayName: 'Root', passwordHash: await hashPassword('Platform-Strong-123') });
  const adminId = [...cloud.users.values()].find((user) => user.platformAdmin).id;
  const company = await cloud.registerCompany({ code: 'co3001', legalName: 'Coord Co', timezone: 'Asia/Baghdad', currency: 'IQD', phone: '0770', address: '', owner: { displayName: 'Owner', username: 'owner_x', passwordHash: await hashPassword(PASSWORD) } });
  await cloud.approveCompany(company.id, adminId, 'co3001');

  const local = new MemoryStore();
  local.companies.set(company.id, { ...cloud.companies.get(company.id) });

  const original = local.deletePlatformCompany.bind(local);
  let attempts = 0;
  local.deletePlatformCompany = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('network unavailable');
    return original(...args);
  };

  await assert.rejects(deleteTenantEverywhere({ cloudStore: cloud, localStore: local, companyId: company.id, companyCode: 'co3001', actorUserId: adminId }), (error) => error.code === 'CONFIRMATION_REQUIRED');

  const pending = await deleteTenantEverywhere({ cloudStore: cloud, localStore: local, companyId: company.id, companyCode: 'co3001', actorUserId: adminId, confirm: true });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.cloud, 'completed');
  assert.equal(pending.local, 'pending');
  assert.equal(cloud.isCompanyTombstoned(company.id), true);
  assert.equal(local.isCompanyTombstoned(company.id), false);

  const completed = await retryTenantDeletion({ cloudStore: cloud, localStore: local, companyId: company.id, companyCode: 'co3001', actorUserId: adminId, confirm: true });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.local, 'completed');
  assert.equal(local.isCompanyTombstoned(company.id), true);

  const again = await retryTenantDeletion({ cloudStore: cloud, localStore: local, companyId: company.id, companyCode: 'co3001', actorUserId: adminId, confirm: true });
  assert.equal(again.status, 'completed');
  assert.equal(again.alreadyDeleted, true);

  await cloud.close();
  await local.close();
});
