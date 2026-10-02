import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, asyncRoute, normalizeCode, normalizeUsername, requireFields } from './lib/http.js';
import { decimal, decimalString } from './lib/decimal.js';
import { hashPassword, hashToken, newSessionToken, payloadHash, verifyPassword } from './lib/security.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(currentDirectory, '../../../public');
const loginAttempts = new Map();

export function createApp({ store, sessionDays = 14, secureCookies = false, allowedOrigins = [] }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'المصدر غير مسموح'));
    },
    credentials: true
  }));
  app.use(express.json({ limit: '512kb' }));
  app.use(express.static(publicDirectory, { extensions: ['html'], etag: true }));

  app.get('/api/v1/health', (req, res) => res.json({ status: 'ok', service: 'almahasib-pro' }));

  app.post('/api/v1/companies/register', asyncRoute(async (req, res) => {
    requireFields(req.body, ['legalName', 'ownerName', 'phone', 'username', 'password']);
    const passwordHash = await passwordHashOrValidation(req.body.password);
    const company = await store.registerCompany({
      code: `REQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
      legalName: req.body.legalName.trim(),
      timezone: req.body.timezone || 'Asia/Baghdad',
      currency: String(req.body.currency || 'IQD').toUpperCase(),
      phone: String(req.body.phone).trim().slice(0,32),
      address: String(req.body.address || '').trim().slice(0,240),
      owner: {
        displayName: req.body.ownerName.trim(),
        username: normalizeUsername(req.body.username),
        passwordHash
      }
    });
    res.status(201).json({ company, message: 'تم استلام طلب الشركة وينتظر اعتماد إدارة المنصة' });
  }));

  app.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
    requireFields(req.body, ['username', 'password']);
    const platform = req.body.platform === true;
    if (!platform && !String(req.body.companyCode || '').trim()) {
      throw new AppError(400, 'COMPANY_CODE_REQUIRED', 'رمز الشركة مطلوب');
    }
    const attemptKey = `${req.ip}:${String(req.body.companyCode || 'platform')}:${String(req.body.username).toLowerCase()}`;
    checkLoginRate(attemptKey);
    const login = await store.findLogin({
      companyCode: platform ? null : normalizeCode(req.body.companyCode),
      username: normalizeUsername(req.body.username), platform
    });
    const valid = login && await verifyPassword(req.body.password, login.user.passwordHash);
    if (!valid) {
      recordFailedLogin(attemptKey);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'بيانات الدخول غير صحيحة');
    }
    if (login.company?.status === 'pending' || login.user.status === 'pending') {
      throw new AppError(403, 'COMPANY_PENDING_APPROVAL', 'الشركة بانتظار الاعتماد');
    }
    if (login.company?.status !== 'active' && !platform) {
      throw new AppError(403, 'COMPANY_INACTIVE', 'الشركة غير مفعلة');
    }
    loginAttempts.delete(attemptKey);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + sessionDays * 86400000).toISOString();
    await store.createSession({
      tokenHash: hashToken(token), userId: login.user.id,
      deviceId: String(req.body.deviceId || 'web-browser').slice(0, 128), expiresAt
    });
    setSessionCookie(res, token, sessionDays, secureCookies);
    const context = await store.getSessionContext(hashToken(token));
    res.json({ token, expiresAt, account: publicContext(context) });
  }));

  app.post('/api/v1/auth/logout', authenticate(store), asyncRoute(async (req, res) => {
    await store.revokeSession(req.auth.tokenHash, req.auth.user.id);
    res.setHeader('Set-Cookie', 'almahasib_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.status(204).end();
  }));

  app.get('/api/v1/bootstrap', authenticate(store), (req, res) => {
    res.json({
      ...publicContext(req.auth),
      sync: { pushUrl: '/api/v1/sync/push', pullUrl: '/api/v1/sync/pull', statusUrl: '/api/v1/sync/status' },
      offlineSessionExpiresAt: req.auth.session.expiresAt,
      serverTime: new Date().toISOString()
    });
  });

  app.get('/api/v1/platform/admins', authenticate(store), permit('company.approve'), asyncRoute(async (req, res) => {
    requirePlatform(req.auth); res.json({ admins: await store.listPlatformAdmins() });
  }));
  app.post('/api/v1/platform/admins', authenticate(store), permit('company.approve'), asyncRoute(async (req, res) => {
    requirePlatform(req.auth); requireFields(req.body, ['username','displayName','password']);
    const passwordHash=await passwordHashOrValidation(req.body.password);
    const admin=await store.createPlatformAdmin({username:normalizeUsername(req.body.username),displayName:String(req.body.displayName).trim().slice(0,120),passwordHash},req.auth.user.id);
    res.status(201).json({admin});
  }));
  app.get('/api/v1/platform/companies', authenticate(store), permit('company.approve'), asyncRoute(async (req,res)=>{
    requirePlatform(req.auth); res.json({companies:await store.listPlatformCompanies()});
  }));
  app.post('/api/v1/platform/companies/:companyId/status', authenticate(store), permit('company.approve'), asyncRoute(async (req,res)=>{
    requirePlatform(req.auth); requireFields(req.body,['status']);
    res.json({company:await store.setCompanyStatus(req.params.companyId,String(req.body.status),req.auth.user.id)});
  }));

  app.patch('/api/v1/platform/companies/:companyId', authenticate(store), asyncRoute(async (req,res)=>{
    requirePlatform(req.auth); res.json({company:await store.updatePlatformCompany(req.params.companyId,req.body||{},req.auth.user.id)});
  }));
  app.delete('/api/v1/platform/companies/:companyId', authenticate(store), asyncRoute(async (req,res)=>{
    requirePlatform(req.auth); res.json(await store.deletePlatformCompany(req.params.companyId,req.auth.user.id));
  }));

  app.get('/api/v1/platform/companies/pending', authenticate(store), permit('company.approve'), asyncRoute(async (req, res) => {
    requirePlatform(req.auth);
    res.json({ companies: await store.listPendingCompanies() });
  }));

  app.post('/api/v1/platform/companies/:companyId/approve', authenticate(store), permit('company.approve'), asyncRoute(async (req, res) => {
    requirePlatform(req.auth);
    res.json({ company: await store.approveCompany(req.params.companyId, req.auth.user.id, req.body?.code) });
  }));

  app.get('/api/v1/roles', authenticate(store), permit('roles.manage'), asyncRoute(async (req, res) => {
    res.json({ roles: await store.listRoles(req.auth.company.id) });
  }));

  app.post('/api/v1/users', authenticate(store), permit('users.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['username', 'displayName', 'password', 'roleCode']);
    const user = await store.createUser(req.auth.company.id, {
      username: normalizeUsername(req.body.username), displayName: req.body.displayName.trim(),
      passwordHash: await passwordHashOrValidation(req.body.password), roleCode: req.body.roleCode,
      scopes: validateScopes(req.body.scopes, req.auth.company)
    }, req.auth.user.id);
    res.status(201).json({ user });
  }));

  app.get('/api/v1/master-data', authenticate(store), permitAny(['catalog.read', 'customers.read', 'suppliers.read', 'inventory.read']), asyncRoute(async (req, res) => {
    res.json(await store.listMasterData(req.auth.company.id));
  }));

  app.post('/api/v1/catalog/units', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    const decimalPlaces = Number(req.body.decimalPlaces ?? 3);
    if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new AppError(400, 'INVALID_DECIMAL_PLACES', 'دقة الوحدة غير صالحة');
    const unit = await store.createUnit(req.auth.company.id, {
      code: entityCode(req.body.code), name: req.body.name.trim(), decimalPlaces
    }, req.auth.user.id);
    res.status(201).json({ unit });
  }));

  app.post('/api/v1/catalog/items', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['sku', 'name', 'baseUnitId']);
    const item = await store.createItem(req.auth.company.id, {
      sku: entityCode(req.body.sku), name: req.body.name.trim(), baseUnitId: uuid(req.body.baseUnitId, 'baseUnitId')
    }, req.auth.user.id);
    res.status(201).json({ item });
  }));

  app.post('/api/v1/catalog/items/:itemId/units', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['unitId', 'conversionFactor']);
    const itemUnit = await store.addItemUnit(req.auth.company.id, uuid(req.params.itemId, 'itemId'), {
      unitId: uuid(req.body.unitId, 'unitId'), conversionFactor: decimalInput(req.body.conversionFactor, { positive: true })
    }, req.auth.user.id);
    res.status(201).json({ itemUnit });
  }));

  app.post('/api/v1/catalog/prices', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['itemId', 'unitId', 'priceType', 'currency', 'amount']);
    if (!['sale', 'purchase'].includes(req.body.priceType)) throw new AppError(400, 'INVALID_PRICE_TYPE', 'نوع السعر غير صالح');
    const price = await store.setPrice(req.auth.company.id, {
      itemId: uuid(req.body.itemId, 'itemId'), unitId: uuid(req.body.unitId, 'unitId'), priceType: req.body.priceType,
      currency: currency(req.body.currency), amount: decimalInput(req.body.amount, { nonNegative: true })
    }, req.auth.user.id);
    res.status(201).json({ price });
  }));

  app.post('/api/v1/catalog/barcodes', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['itemId', 'unitId', 'barcode']);
    const barcode = String(req.body.barcode).trim();
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(barcode)) throw new AppError(400, 'INVALID_BARCODE', 'الباركود غير صالح');
    const result = await store.setBarcode(req.auth.company.id, {
      itemId: uuid(req.body.itemId, 'itemId'), unitId: uuid(req.body.unitId, 'unitId'), barcode
    }, req.auth.user.id);
    res.status(201).json({ barcode: result });
  }));

  app.post('/api/v1/customers', authenticate(store), permit('customers.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    const customer = await store.createParty(req.auth.company.id, 'customer', {
      code: entityCode(req.body.code), name: req.body.name.trim(), phone: req.body.phone,
      creditLimit: decimalInput(req.body.creditLimit || '0', { nonNegative: true })
    }, req.auth.user.id);
    res.status(201).json({ customer });
  }));

  app.post('/api/v1/suppliers', authenticate(store), permit('suppliers.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    const supplier = await store.createParty(req.auth.company.id, 'supplier', {
      code: entityCode(req.body.code), name: req.body.name.trim(), phone: req.body.phone
    }, req.auth.user.id);
    res.status(201).json({ supplier });
  }));

  app.post('/api/v1/warehouses', authenticate(store), permit('inventory.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    if (req.body.kind && !['standard', 'vehicle', 'pos'].includes(req.body.kind)) throw new AppError(400, 'INVALID_WAREHOUSE_KIND', 'نوع المخزن غير صالح');
    const warehouse = await store.createWarehouse(req.auth.company.id, {
      code: entityCode(req.body.code), name: req.body.name.trim(), kind: req.body.kind,
      branchId: req.body.branchId ? uuid(req.body.branchId, 'branchId') : null
    }, req.auth.user.id);
    res.status(201).json({ warehouse });
  }));

  app.post('/api/v1/representatives', authenticate(store), permit('representatives.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['userId', 'vehicleWarehouseId', 'code', 'name']);
    const representative = await store.createRepresentative(req.auth.company.id, { userId: uuid(req.body.userId, 'userId'), vehicleWarehouseId: uuid(req.body.vehicleWarehouseId, 'vehicleWarehouseId'), code: entityCode(req.body.code), name: String(req.body.name).trim(), deviceId: req.body.deviceId ? String(req.body.deviceId).slice(0, 128) : null }, req.auth.user.id);
    res.status(201).json({ representative });
  }));

  app.put('/api/v1/representatives/:representativeId/customers/:customerId', authenticate(store), permit('representatives.manage'), asyncRoute(async (req, res) => {
    const assignment = await store.assignRepresentativeCustomer(req.auth.company.id, uuid(req.params.representativeId, 'representativeId'), { customerId: uuid(req.params.customerId, 'customerId'), visitOrder: Number(req.body.visitOrder || 0), creditLimit: req.body.creditLimit == null ? null : decimalInput(req.body.creditLimit, { nonNegative: true }) }, req.auth.user.id);
    res.json({ assignment });
  }));

  app.post('/api/v1/representatives/:representativeId/routes', authenticate(store), permit('representatives.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    if (!Array.isArray(req.body.stops) || !req.body.stops.length) throw new AppError(400, 'ROUTE_STOPS_REQUIRED', 'محطات المسار مطلوبة');
    const route = await store.createRepresentativeRoute(req.auth.company.id, uuid(req.params.representativeId, 'representativeId'), { code: entityCode(req.body.code), name: String(req.body.name).trim(), routeDate: req.body.routeDate || null, stops: req.body.stops.map((stop, index) => ({ customerId: uuid(stop.customerId, 'customerId'), stopOrder: Number(stop.stopOrder || index + 1), note: stop.note ? String(stop.note).slice(0, 250) : null })) }, req.auth.user.id);
    res.status(201).json({ route });
  }));

  app.get('/api/v1/representatives/bootstrap', authenticate(store), permit('representatives.read'), asyncRoute(async (req, res) => {
    res.json(await store.getRepresentativeBootstrap(req.auth, req.query.representativeId ? uuid(req.query.representativeId, 'representativeId') : null));
  }));

  app.post('/api/v1/representatives/operations', authenticate(store), asyncRoute(async (req, res) => {
    const operation = validateOperation({ operationId: req.body.operationId, deviceId: req.body.deviceId, clientSequence: req.body.clientSequence, occurredAt: req.body.occurredAt, schemaVersion: 1, dependencies: req.body.dependencies || [], type: req.body.type, payload: validateRepresentativePayload(req.body.type, req.body.payload) });
    requireRepresentativePermission(req.auth, operation.type);
    const [result] = await store.pushOperations(req.auth, [operation]);
    res.status(result.status === 'acknowledged' ? 201 : 409).json({ result });
  }));

  app.post('/api/v1/commerce/commit', authenticate(store), asyncRoute(async (req, res) => {
    const operation = validateOperation({
      operationId: req.body.operationId, deviceId: req.body.deviceId,
      clientSequence: req.body.clientSequence, occurredAt: req.body.occurredAt,
      schemaVersion: req.body.schemaVersion || 1, dependencies: req.body.dependencies || [],
      type: 'commerce.commit', payload: validateCommercePayload(req.body.document)
    });
    requireCommercePermission(req.auth, operation.payload.documentType);
    const [result] = await store.pushOperations(req.auth, [operation]);
    res.status(result.status === 'acknowledged' ? 201 : 409).json({ result });
  }));

  app.get('/api/v1/commerce/documents', authenticate(store), permitAny(['sales.read', 'purchasing.read']), asyncRoute(async (req, res) => {
    res.json({ documents: await store.listCommerceDocuments(req.auth.company.id) });
  }));

  app.post('/api/v1/pos/devices', authenticate(store), permit('pos.device.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['id', 'warehouseId', 'code', 'name', 'interfaceMode']);
    if (!['restaurant', 'market', 'enterprise'].includes(req.body.interfaceMode)) throw new AppError(400, 'INVALID_POS_INTERFACE', 'واجهة الكاشير غير صالحة');
    const device = await store.createPosDevice(req.auth.company.id, {
      id: uuid(req.body.id, 'id'), warehouseId: uuid(req.body.warehouseId, 'warehouseId'),
      branchId: req.body.branchId ? uuid(req.body.branchId, 'branchId') : null,
      code: entityCode(req.body.code), name: req.body.name.trim(), interfaceMode: req.body.interfaceMode,
      maxDiscountPercent: decimalInput(req.body.maxDiscountPercent || '0', { nonNegative: true })
    }, req.auth.user.id);
    res.status(201).json({ device });
  }));

  app.put('/api/v1/pos/devices/:deviceId/allocations/:itemId', authenticate(store), permit('inventory.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['quantity']);
    const allocation = await store.setPosAllocation(req.auth.company.id, uuid(req.params.deviceId, 'deviceId'), {
      itemId: uuid(req.params.itemId, 'itemId'), quantity: decimalInput(req.body.quantity, { nonNegative: true }),
      expiresAt: req.body.expiresAt || null
    }, req.auth.user.id);
    res.json({ allocation });
  }));

  app.get('/api/v1/pos/bootstrap', authenticate(store), asyncRoute(async (req, res) => {
    const deviceId = uuid(req.query.deviceId, 'deviceId');
    res.json(await store.getPosBootstrap(req.auth.company.id, deviceId));
  }));

  app.post('/api/v1/pos/operations', authenticate(store), asyncRoute(async (req, res) => {
    const allowedTypes = ['pos.shift.open', 'pos.sale', 'pos.return', 'pos.shift.close'];
    if (!allowedTypes.includes(req.body.type)) throw new AppError(400, 'INVALID_POS_OPERATION', 'عملية الكاشير غير صالحة');
    const operation = validateOperation({
      operationId: req.body.operationId, deviceId: req.body.deviceId, clientSequence: req.body.clientSequence,
      occurredAt: req.body.occurredAt, schemaVersion: 1, dependencies: req.body.dependencies || [],
      type: req.body.type, payload: validatePosPayload(req.body.type, req.body.payload)
    });
    requirePosPermission(req.auth, operation.type);
    const [result] = await store.pushOperations(req.auth, [operation]);
    res.status(result.status === 'acknowledged' ? 201 : 409).json({ result });
  }));

  app.post('/api/v1/sync/push', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.operations) || req.body.operations.length > 100) {
      throw new AppError(400, 'INVALID_SYNC_BATCH', 'دفعة المزامنة يجب أن تحتوي حتى 100 عملية');
    }
    const operations = req.body.operations.map(validateOperation);
    for (const operation of operations) {
      if (operation.type === 'financial.record' && !req.auth.permissions.includes('accounting.post')) {
        throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لتسجيل العملية المالية');
      }
      if (operation.type === 'commerce.commit') requireCommercePermission(req.auth, operation.payload.documentType);
      if (operation.type.startsWith('pos.')) requirePosPermission(req.auth, operation.type);
      if (operation.type.startsWith('representative.')) { operation.payload = validateRepresentativePayload(operation.type, operation.payload); requireRepresentativePermission(req.auth, operation.type); }
    }
    const results = await store.pushOperations(req.auth, operations);
    res.json({ results });
  }));

  app.get('/api/v1/sync/pull', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    const cursor = Math.max(0, Number.parseInt(req.query.cursor || '0', 10) || 0);
    res.json(await store.pullChanges(req.auth.company.id, cursor, 100));
  }));

  app.get('/api/v1/sync/status', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    res.json(await store.syncStatus(req.auth.company.id, req.auth.user.id, req.auth.session.deviceId));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } }));
  app.get('*', (req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: status >= 500 ? 'حدث خطأ داخلي' : error.message,
        ...(error.details ? { details: error.details } : {})
      }
    });
  });
  return app;
}

function authenticate(store) {
  return asyncRoute(async (req, res, next) => {
    const authorization = req.get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    const token = bearer || parseCookies(req.get('cookie')).almahasib_session;
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'تسجيل الدخول مطلوب');
    const tokenHash = hashToken(token);
    const context = await store.getSessionContext(tokenHash);
    if (!context) throw new AppError(401, 'SESSION_INVALID', 'الجلسة منتهية أو ملغاة');
    req.auth = { ...context, tokenHash };
    next();
  });
}

function permit(permission) {
  return (req, res, next) => {
    if (!req.auth.permissions.includes(permission)) return next(new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لهذه العملية'));
    next();
  };
}

function permitAny(permissions) {
  return (req, res, next) => {
    if (!permissions.some((permission) => req.auth.permissions.includes(permission))) return next(new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لهذه العملية'));
    next();
  };
}

function requirePlatform(context) {
  if (!context.user.platformAdmin || context.company) throw new AppError(403, 'PLATFORM_ONLY', 'هذه العملية لإدارة المنصة فقط');
}

function validateOperation(operation) {
  if (!operation || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operation.operationId || '')) {
    throw new AppError(400, 'INVALID_OPERATION_ID', 'معرف عملية المزامنة غير صالح');
  }
  if (!Number.isSafeInteger(operation.clientSequence) || operation.clientSequence < 1) {
    throw new AppError(400, 'INVALID_CLIENT_SEQUENCE', 'تسلسل العملية غير صالح');
  }
  if (typeof operation.type !== 'string' || !operation.payload || typeof operation.payload !== 'object') {
    throw new AppError(400, 'INVALID_OPERATION', 'عملية المزامنة غير مكتملة');
  }
  const computedHash = payloadHash(operation.payload);
  if (operation.payloadHash && operation.payloadHash !== computedHash) {
    throw new AppError(400, 'PAYLOAD_HASH_MISMATCH', 'بصمة محتوى العملية غير مطابقة');
  }
  return {
    operationId: operation.operationId, deviceId: String(operation.deviceId || 'web-browser').slice(0, 128),
    clientSequence: operation.clientSequence, schemaVersion: operation.schemaVersion || 1,
    entityVersion: operation.entityVersion ?? null, dependencies: operation.dependencies || [],
    occurredAt: operation.occurredAt || new Date().toISOString(), type: operation.type,
    payloadHash: computedHash, payload: operation.payload
  };
}

function validateScopes(scopes, company) {
  if (scopes == null) return undefined;
  if (!Array.isArray(scopes) || scopes.some((scope) => !scope || !['company', 'branch', 'warehouse', 'pos', 'customers'].includes(scope.type))) {
    throw new AppError(400, 'INVALID_SCOPES', 'نطاقات المستخدم غير صالحة');
  }
  if (scopes.some((scope) => scope.type === 'company' && scope.id !== company.id)) {
    throw new AppError(400, 'CROSS_COMPANY_SCOPE', 'لا يمكن منح نطاق لشركة أخرى');
  }
  return scopes;
}

function validateCommercePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new AppError(400, 'INVALID_DOCUMENT', 'المستند غير مكتمل');
  requireFields(payload, ['documentType', 'documentNumber', 'warehouseId', 'currency']);
  if (!['purchase', 'sale', 'purchase_return', 'sale_return'].includes(payload.documentType)) throw new AppError(400, 'INVALID_DOCUMENT_TYPE', 'نوع المستند غير صالح');
  if (!Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 500) throw new AppError(400, 'DOCUMENT_LINES_REQUIRED', 'بنود المستند مطلوبة');
  const isReturn = payload.documentType.endsWith('_return');
  if (isReturn && !payload.originalDocumentId) throw new AppError(400, 'ORIGINAL_DOCUMENT_REQUIRED', 'المستند الأصلي مطلوب للمرتجع');
  return {
    documentType: payload.documentType, documentNumber: String(payload.documentNumber).trim().slice(0, 64),
    warehouseId: uuid(payload.warehouseId, 'warehouseId'), partyId: payload.partyId ? uuid(payload.partyId, 'partyId') : null,
    originalDocumentId: isReturn ? uuid(payload.originalDocumentId, 'originalDocumentId') : null,
    currency: currency(payload.currency),
    lines: payload.lines.map((line) => ({
      itemId: uuid(line.itemId, 'itemId'), unitId: uuid(line.unitId, 'unitId'),
      originalLineId: isReturn ? uuid(line.originalLineId, 'originalLineId') : null,
      quantity: decimalInput(line.quantity, { positive: true }),
      ...(isReturn ? {} : { unitPrice: decimalInput(line.unitPrice, { nonNegative: true }) })
    })),
    payments: (payload.payments || []).map((payment) => {
      if (!['cash', 'bank', 'card'].includes(payment.method)) throw new AppError(400, 'INVALID_PAYMENT_METHOD', 'وسيلة الدفع غير صالحة');
      return { method: payment.method, amount: decimalInput(payment.amount, { positive: true }), reference: payment.reference ? String(payment.reference).slice(0, 128) : null };
    })
  };
}

function validatePosPayload(type, payload) {
  if (!payload || typeof payload !== 'object') throw new AppError(400, 'INVALID_POS_PAYLOAD', 'بيانات عملية الكاشير غير مكتملة');
  if (type === 'pos.shift.open') {
    requireFields(payload, ['shiftId', 'deviceId', 'openingFloat']);
    return { shiftId: uuid(payload.shiftId, 'shiftId'), deviceId: uuid(payload.deviceId, 'deviceId'), openingFloat: decimalInput(payload.openingFloat, { nonNegative: true }) };
  }
  if (type === 'pos.shift.close') {
    requireFields(payload, ['shiftId', 'deviceId', 'countedCash']);
    return { shiftId: uuid(payload.shiftId, 'shiftId'), deviceId: uuid(payload.deviceId, 'deviceId'), countedCash: decimalInput(payload.countedCash, { nonNegative: true }), submittedOffline: payload.submittedOffline === true };
  }
  requireFields(payload, ['shiftId', 'deviceId', 'interfaceMode', 'documentNumber', 'currency']);
  if (!['restaurant', 'market', 'enterprise'].includes(payload.interfaceMode)) throw new AppError(400, 'INVALID_POS_INTERFACE', 'واجهة الكاشير غير صالحة');
  const documentType = type === 'pos.return' ? 'sale_return' : 'sale';
  const commerce = validateCommercePayload({ ...payload, documentType, warehouseId: payload.warehouseId || payload.deviceId });
  return {
    ...commerce, shiftId: uuid(payload.shiftId, 'shiftId'), deviceId: uuid(payload.deviceId, 'deviceId'),
    interfaceMode: payload.interfaceMode, discountAmount: type === 'pos.return' ? '0.000000' : decimalInput(payload.discountAmount || '0', { nonNegative: true }),
    orderContext: sanitizeOrderContext(payload.orderContext), offlineOrigin: payload.offlineOrigin === true
  };
}

function sanitizeOrderContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof item)) result[key] = String(item).slice(0, 128);
  }
  return result;
}

function requireCommercePermission(context, documentType) {
  const permission = {
    purchase: 'purchasing.approve', purchase_return: 'purchasing.return',
    sale: 'sales.approve', sale_return: 'sales.return'
  }[documentType];
  if (!permission || !context.permissions.includes(permission)) throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لاعتماد هذا المستند');
}

function requirePosPermission(context, type) {
  const permission = {
    'pos.shift.open': 'pos.shift.open', 'pos.shift.close': 'pos.shift.close',
    'pos.sale': 'sales.approve', 'pos.return': 'sales.return'
  }[type];
  if (!permission || !context.permissions.includes(permission)) throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لعملية الكاشير');
}

function requireRepresentativePermission(context, type) {
  const permission = type === 'representative.load' ? 'representatives.manage' : type === 'representative.handover.review' ? 'representatives.review' : type === 'representative.collection' ? 'representatives.collect' : type === 'representative.handover.submit' ? 'representatives.handover' : 'representatives.operate';
  if (!context.permissions.includes(permission)) throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لعملية المندوب');
}

function validateRepresentativePayload(type, payload) {
  if (!payload || typeof payload !== 'object') throw new AppError(400, 'INVALID_REPRESENTATIVE_PAYLOAD', 'بيانات عملية المندوب غير مكتملة');
  requireFields(payload, ['representativeId']);
  const base = { representativeId: uuid(payload.representativeId, 'representativeId') };
  if (type === 'representative.load') {
    requireFields(payload, ['sourceWarehouseId', 'transferNumber']);
    return { ...base, sourceWarehouseId: uuid(payload.sourceWarehouseId, 'sourceWarehouseId'), transferNumber: String(payload.transferNumber).trim().slice(0, 64), lines: representativeStockLines(payload.lines) };
  }
  if (type === 'representative.order') {
    requireFields(payload, ['orderId', 'customerId', 'orderNumber', 'currency']);
    return { ...base, orderId: uuid(payload.orderId, 'orderId'), customerId: uuid(payload.customerId, 'customerId'), orderNumber: String(payload.orderNumber).trim().slice(0, 64), currency: currency(payload.currency), lines: representativeSaleLines(payload.lines) };
  }
  if (type === 'representative.sale' || type === 'representative.return') {
    const documentType = type.endsWith('return') ? 'sale_return' : 'sale';
    const commerce = validateCommercePayload({ ...payload, documentType, warehouseId: payload.warehouseId || payload.representativeId });
    return { ...commerce, ...base, orderId: payload.orderId ? uuid(payload.orderId, 'orderId') : null, discountAmount: documentType === 'sale' ? decimalInput(payload.discountAmount || '0', { nonNegative: true }) : '0.000000' };
  }
  if (type === 'representative.collection') {
    requireFields(payload, ['customerId', 'receiptNumber', 'amount', 'currency']);
    return { ...base, customerId: uuid(payload.customerId, 'customerId'), receiptNumber: String(payload.receiptNumber).trim().slice(0, 64), amount: decimalInput(payload.amount, { positive: true }), currency: currency(payload.currency) };
  }
  if (type === 'representative.handover.submit') {
    requireFields(payload, ['handoverId', 'destinationWarehouseId', 'handoverNumber', 'submittedCash', 'currency']);
    return { ...base, handoverId: uuid(payload.handoverId, 'handoverId'), destinationWarehouseId: uuid(payload.destinationWarehouseId, 'destinationWarehouseId'), handoverNumber: String(payload.handoverNumber).trim().slice(0, 64), submittedCash: decimalInput(payload.submittedCash, { nonNegative: true }), currency: currency(payload.currency), lines: representativeStockLines(payload.lines || []) };
  }
  if (type === 'representative.handover.review') {
    requireFields(payload, ['handoverId', 'reviewedCash']);
    return { ...base, handoverId: uuid(payload.handoverId, 'handoverId'), reviewedCash: decimalInput(payload.reviewedCash, { nonNegative: true }) };
  }
  throw new AppError(400, 'INVALID_REPRESENTATIVE_OPERATION', 'عملية المندوب غير صالحة');
}

function representativeStockLines(lines) {
  if (!Array.isArray(lines) || lines.length > 500) throw new AppError(400, 'INVALID_TRANSFER_LINES', 'بنود التحويل غير صالحة');
  return lines.map((line) => ({ itemId: uuid(line.itemId, 'itemId'), quantity: decimalInput(line.quantity, { positive: true }) }));
}

function representativeSaleLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 500) throw new AppError(400, 'DOCUMENT_LINES_REQUIRED', 'بنود الطلب مطلوبة');
  return lines.map((line) => ({ itemId: uuid(line.itemId, 'itemId'), unitId: uuid(line.unitId, 'unitId'), quantity: decimalInput(line.quantity, { positive: true }), unitPrice: decimalInput(line.unitPrice, { nonNegative: true }) }));
}

function entityCode(value) {
  const code = String(value || '').trim();
  if (!/^[\p{L}\p{N}_.-]{1,64}$/u.test(code)) throw new AppError(400, 'INVALID_CODE', 'الرمز غير صالح');
  return code;
}

function uuid(value, field) {
  const text = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new AppError(400, 'INVALID_UUID', `المعرف ${field} غير صالح`);
  return text;
}

function decimalInput(value, options = {}) {
  try {
    return decimalString(decimal(value, options));
  } catch {
    throw new AppError(400, 'INVALID_DECIMAL', 'القيمة العشرية غير صالحة');
  }
}

function currency(value) {
  const result = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new AppError(400, 'INVALID_CURRENCY', 'رمز العملة غير صالح');
  return result;
}

function publicContext(context) {
  return {
    user: context.user, company: context.company, roles: context.roles,
    permissions: context.permissions, scopes: context.scopes
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key]) => key));
}

function setSessionCookie(res, token, days, secure) {
  const attributes = [`almahasib_session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${days * 86400}`];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function checkLoginRate(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return;
  if (attempt.blockedUntil > Date.now()) {
    throw new AppError(429, 'LOGIN_RATE_LIMITED', 'محاولات كثيرة، حاول لاحقًا');
  }
}

function recordFailedLogin(key) {
  const previous = loginAttempts.get(key) || { count: 0, blockedUntil: 0 };
  previous.count += 1;
  if (previous.count >= 5) previous.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(key, previous);
}

async function passwordHashOrValidation(password) {
  try {
    return await hashPassword(password);
  } catch (error) {
    if (error.message === 'PASSWORD_TOO_SHORT') throw new AppError(400, 'WEAK_PASSWORD', 'كلمة المرور يجب ألا تقل عن 10 أحرف');
    throw error;
  }
}
