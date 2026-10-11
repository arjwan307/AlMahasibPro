import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProductCloud } from '../../apps/api/src/cloud-server.js';

const setupToken = 'product-cloud-setup-key-longer-than-24';

async function json(response) { return { status: response.status, data: response.status === 204 ? {} : await response.json(), cookie: response.headers.get('set-cookie') }; }

test('dedicated company cloud serves only company pages, isolates its database and blocks cross-product registration', async () => {
  const directory = await mkdtemp(join(tmpdir(),'product-cloud-company-'));
  const previousMongo = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  let runtime;
  try {
    runtime = await startProductCloud({ product: 'company', dataDirectory: directory, setupToken, origin: 'http://localhost', port: 0 });
    const request = (path, body, cookie = '') => fetch(runtime.url + path, { headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const health = await json(await request('/api/health'));
    assert.equal(health.data.storage, 'sqlite');
    assert.equal(health.data.service, 'AlMahasibPro');
    assert.equal(runtime.store.filename, join(directory, 'enterprise.sqlite'));
    assert.equal((await json(await request('/api/local/status'))).data.initialized, false);
    assert.equal((await json(await request('/api/local/setup', { setupToken: 'wrong-key-too-short-rejected', legalName: 'شركة', ownerName: 'مدير', username: 'owner', password: 'Strong-Password-123' }))).status, 403);
    assert.equal((await json(await request('/api/local/setup', { setupToken, legalName: 'شركة', ownerName: 'مدير', username: 'owner', password: 'Strong-Password-123' }))).status, 201);
    const status = (await json(await request('/api/local/status'))).data;
    assert.equal(status.initialized, true);
    assert.equal(status.companyCode, 'company');
    assert.equal([...runtime.store.companies.values()].find(company => company.product === 'company').legalName, 'شركة');
    const login = await json(await request('/api/v1/auth/login', { companyCode: 'company', username: 'owner', password: 'Strong-Password-123' }));
    assert.equal(login.status, 200);
    assert.match(login.cookie, /^almahasib_company_session=/);
    assert.equal((await request('/enterprise.html')).status, 200);
    assert.equal((await request('/pos.html')).status, 404);
    assert.equal((await request('/retail-login.html')).status, 404);
    assert.equal((await request('/retail/api/local/status')).status, 404);
    const blocked = await json(await request('/api/v1/companies/register', { product: 'retail', legalName: 'مطعم', ownerName: 'مالك', phone: '07700000000', username: 'shop', password: 'Strong-Password-123' }));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'PRODUCT_SCOPE_FORBIDDEN');
  } finally {
    if (runtime) await runtime.close();
    if (previousMongo !== undefined) process.env.MONGODB_URI = previousMongo;
    await rm(directory, { recursive: true, force: true });
  }
});

test('dedicated retail cloud serves only retail pages, keeps its own database and blocks cross-product registration', async () => {
  const directory = await mkdtemp(join(tmpdir(),'product-cloud-retail-'));
  const previousMongo = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  let runtime;
  try {
    runtime = await startProductCloud({ product: 'retail', dataDirectory: directory, setupToken, origin: 'http://localhost', port: 0 });
    const request = (path, body, cookie = '') => fetch(runtime.url + path, { headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const health = await json(await request('/api/health'));
    assert.equal(health.data.storage, 'sqlite');
    assert.equal(runtime.store.filename, join(directory, 'retail', 'enterprise.sqlite'));
    const home = await fetch(runtime.url + '/', { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/retail-login.html');
    assert.equal((await json(await request('/api/local/status'))).data.initialized, false);
    assert.equal((await json(await request('/api/local/setup', { setupToken, legalName: 'مطعم', ownerName: 'مدير', username: 'owner', password: 'Strong-Password-123' }))).status, 201);
    const status = (await json(await request('/api/local/status'))).data;
    assert.equal(status.initialized, true);
    assert.equal(status.companyCode, 'retail');
    assert.equal([...runtime.store.companies.values()].find(company => company.product === 'retail').legalName, 'مطعم');
    const login = await json(await request('/api/v1/auth/login', { companyCode: 'retail', username: 'owner', password: 'Strong-Password-123' }));
    assert.equal(login.status, 200);
    assert.match(login.cookie, /^almahasib_retail_session=/);
    assert.equal((await request('/retail-login.html')).status, 200);
    assert.equal((await request('/pos.html')).status, 200);
    assert.equal((await request('/market-cashier.html')).status, 200);
    assert.equal((await request('/enterprise.html')).status, 404);
    assert.equal((await request('/representative.html')).status, 404);
    const blocked = await json(await request('/api/v1/companies/register', { product: 'company', legalName: 'شركة', ownerName: 'مالك', phone: '07700000000', username: 'shop', password: 'Strong-Password-123' }));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'PRODUCT_SCOPE_FORBIDDEN');
  } finally {
    if (runtime) await runtime.close();
    if (previousMongo !== undefined) process.env.MONGODB_URI = previousMongo;
    await rm(directory, { recursive: true, force: true });
  }
});

test('dedicated cloud rejects unknown products and a missing data directory', async () => {
  await assert.rejects(() => startProductCloud({ product: 'unified', dataDirectory: tmpdir(), setupToken, origin: 'http://localhost', port: 0 }), /ALMAHASIB_PRODUCT must be company or retail/);
  await assert.rejects(() => startProductCloud({ product: 'company', dataDirectory: '', setupToken, origin: 'http://localhost', port: 0 }), /ALMAHASIB_DATA_DIR is required/);
});
