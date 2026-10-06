import express from 'express';
import { PERMISSIONS } from './permissions.js';
import cors from 'cors';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(publicDirectory, { extensions: ['html'], etag: true }));

  app.get('/api/v1/health', (req, res) => res.json({ status: 'ok', service: 'almahasib-pro' }));

  app.post('/api/v1/companies/register', asyncRoute(async (req, res) => {
    requireFields(req.body, ['legalName', 'ownerName', 'phone', 'username', 'password']);
    const passwordHash = await passwordHashOrValidation(req.body.password);
    const company = await store.registerCompany({
      code: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`,
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
    if (login.user.status !== 'active') throw new AppError(403, 'USER_INACTIVE', 'حساب المستخدم موقوف');
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

  app.post('/api/v1/roles', authenticate(store), permit('roles.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['name']);
    const name = String(req.body.name).trim();
    if (!name || name.length > 120) throw new AppError(400, 'INVALID_ROLE_NAME', 'اسم الدور مطلوب ولا يتجاوز ١٢٠ حرفًا');
    const permissions = req.body.permissions;
    if (!Array.isArray(permissions) || permissions.some(value => !PERMISSIONS.includes(value) || value === 'company.approve')) throw new AppError(400, 'INVALID_PERMISSIONS', 'الصلاحيات غير صالحة');
    if (!store.createRole) throw new AppError(501, 'STORE_UNSUPPORTED', 'إضافة الأدوار غير متاحة لهذا الخادم');
    res.status(201).json({ role: await store.createRole(req.auth.company.id, { name, permissions }, req.auth.user.id) });
  }));

  app.post('/api/v1/users', authenticate(store), permit('users.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['username', 'displayName', 'password', 'roleCode']);
    const user = await store.createUser(req.auth.company.id, {
      username: normalizeUsername(req.body.username), displayName: req.body.displayName.trim(),
      passwordHash: await passwordHashOrValidation(req.body.password), roleCode: req.body.roleCode,
      permissions: req.body.permissions, scopes: validateScopes(req.body.scopes, req.auth.company)
    }, req.auth.user.id);
    res.status(201).json({ user });
  }));

  app.get('/api/v1/users', authenticate(store), permit('users.manage'), asyncRoute(async (req, res) => {
    if (!store.listUsers) throw new AppError(501, 'STORE_UNSUPPORTED', 'إدارة الحسابات التفصيلية غير متاحة لهذا الخادم بعد');
    res.json({ users: await store.listUsers(req.auth.company.id), roles: await store.listRoles(req.auth.company.id), permissions: PERMISSIONS.filter(value => value !== 'company.approve') });
  }));

  app.put('/api/v1/users/:userId', authenticate(store), permit('users.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['username', 'displayName', 'roleCode', 'status']);
    if (!store.updateUser) throw new AppError(501, 'STORE_UNSUPPORTED', 'تعديل الحسابات غير متاح لهذا الخادم بعد');
    res.json({ user: await store.updateUser(req.auth.company.id, req.params.userId, {
      username: normalizeUsername(req.body.username), displayName: String(req.body.displayName).trim().slice(0, 120),
      roleCode: req.body.roleCode, status: req.body.status, permissions: req.body.permissions,
      passwordHash: req.body.password ? await passwordHashOrValidation(req.body.password) : undefined
    }, req.auth.user.id) });
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
    for(const operation of operations){if(operation.type==='market.transaction.shift_close'&&results.some(r=>r.operationId===operation.operationId&&r.status==='acknowledged'))await revokeScannerShift(req.auth.company.id,operation.payload.shiftId);}
    res.json({ results });
  }));

  app.get('/api/v1/sync/pull', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    const cursor = Math.max(0, Number.parseInt(req.query.cursor || '0', 10) || 0);
    res.json(await store.pullChanges(req.auth.company.id, cursor, 100));
  }));

  app.get('/api/v1/sync/status', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    res.json(await store.syncStatus(req.auth.company.id, req.auth.user.id, req.auth.session.deviceId));
  }));

  // Company-scoped market cloud snapshot. This deliberately stores the snapshot
  // through the existing sync change stream, so Mongo-backed stores persist it
  // with the same company isolation as every other synchronized entity.
  async function currentMarketSnapshot(companyId) {
    let cursor=0,latestRow=null,guard=0;
    do { const page=await store.pullChanges(companyId,cursor,500); for(const row of page.changes||[]) if(row.entityType==='market.snapshot') latestRow=row;
      if(!page.hasMore||page.nextCursor===cursor)break; cursor=page.nextCursor; guard+=1;
    } while(guard<200);
    return latestRow?.payload||latestRow?.data||null;
  }
  async function marketTransactionExists(companyId,predicate) {
    let cursor=0,guard=0;
    do { const page=await store.pullChanges(companyId,cursor,500);
      for(const row of page.changes||[]) if(row.entityType==='market.transaction'&&predicate(row.payload||row.data||{})) return true;
      if(!page.hasMore||page.nextCursor===cursor)break; cursor=page.nextCursor; guard+=1;
    } while(guard<200);
    return false;
  }

  app.post('/api/v1/market/stock-reversal', authenticate(store), permit('sync.use'), asyncRoute(async (req,res)=>{
    const kind=String(req.body?.kind||''), invoice=String(req.body?.invoice||'');
    if(!['return','cancel'].includes(kind)||!invoice) throw new AppError(400,'INVALID_MARKET_REVERSAL','عملية المرتجع أو الإلغاء غير صالحة');
    if(await marketTransactionExists(req.auth.company.id,(x)=>x.invoice===invoice&&x.kind==='cancel')) throw new AppError(409,'MARKET_INVOICE_CANCELLED','الفاتورة ملغاة مسبقًا');
    if(kind==='cancel'&&await marketTransactionExists(req.auth.company.id,(x)=>x.invoice===invoice&&x.kind==='return')) throw new AppError(409,'MARKET_INVOICE_HAS_RETURN','لا يمكن إلغاء فاتورة عليها مرتجع');
    const snapshot=await currentMarketSnapshot(req.auth.company.id); if(!snapshot?.catalog) throw new AppError(409,'MARKET_CATALOG_NOT_SYNCED','المخزون المركزي غير متاح');
    const catalog=structuredClone(snapshot.catalog),lines=Array.isArray(req.body?.lines)?req.body.lines:[];
    if(!lines.length) throw new AppError(400,'INVALID_MARKET_REVERSAL','لا توجد مواد لإعادتها');
    for(const line of lines){const item=catalog.find(x=>String(x.id)===String(line.itemId)),qty=Number(line.quantity||0);if(!item||!(qty>0))throw new AppError(409,'MARKET_ITEM_NOT_FOUND','أحد أصناف المرتجع غير موجود');item.qty=Number(item.qty||0)+qty}
    const now=new Date().toISOString(),snap=validateOperation({operationId:randomUUID(),deviceId:String(req.auth.session.deviceId||'market-web'),clientSequence:Date.now(),occurredAt:now,schemaVersion:1,dependencies:[],type:'market.snapshot',payload:{catalog,updatedAt:now}});
    const tx=validateOperation({operationId:randomUUID(),deviceId:String(req.auth.session.deviceId||'market-web'),clientSequence:Date.now()+1,occurredAt:now,schemaVersion:1,dependencies:[],type:'market.transaction.'+kind,payload:{...req.body,id:String(req.body?.id||randomUUID()),kind,occurredAt:now}});
    const results=await store.pushOperations(req.auth,[snap,tx]);if(results.some(x=>x.status!=='acknowledged'))throw new AppError(409,'MARKET_REVERSAL_REJECTED','تعذر اعتماد العملية مركزيًا');
    res.json({ok:true,snapshot:{catalog,updatedAt:now}});
  }));

  const marketScannerLinks = new Map();
  const scannerCollection = store.db?.collection('market_scanner_links');
  async function getScannerLink(token){
    return scannerCollection ? scannerCollection.findOne({_id:token,revoked:false}) : marketScannerLinks.get(token);
  }
  async function revokeScannerShift(companyId,shiftId){
    if(scannerCollection)await scannerCollection.updateMany({companyId,shiftId,revoked:false},{$set:{revoked:true},$unset:{codes:''}});
    else for(const [token,link] of marketScannerLinks)if(link.companyId===companyId&&link.shiftId===shiftId)marketScannerLinks.delete(token);
  }
  function requireScannerLink(link){
    if(!link||link.revoked)throw new AppError(410,'SCANNER_LINK_EXPIRED','تم إيقاف الربط أو إغلاق الشفت');
    return link;
  }
  app.post('/api/v1/market/scanner/pair', authenticate(store), permit('sync.use'), asyncRoute(async (req,res)=>{
    const terminal=String(req.body?.terminal||'main').slice(0,128),shiftId=uuid(req.body?.shiftId,'shiftId');
    const opened=await marketTransactionExists(req.auth.company.id,x=>x.kind==='shift_open'&&x.shiftId===shiftId);
    const closed=await marketTransactionExists(req.auth.company.id,x=>x.kind==='shift_close'&&x.shiftId===shiftId);
    if(!opened||closed)throw new AppError(409,'SCANNER_SHIFT_NOT_OPEN','افتح الشفت وزامنه قبل ربط الماسح');
    await revokeScannerShift(req.auth.company.id,shiftId);
    const token=randomUUID().replace(/-/g,''),link={_id:token,companyId:req.auth.company.id,terminal,shiftId,cashier:String(req.body?.cashier||'').slice(0,100),createdAt:new Date().toISOString(),revoked:false,codes:[]};
    if(scannerCollection)await scannerCollection.insertOne(link);else marketScannerLinks.set(token,link);
    res.set('Cache-Control','no-store').json({token,expiresIn:null,validUntil:'shift_close_or_disconnect'});
  }));
  app.get('/api/v1/market/scanner/:token/status', asyncRoute(async (req,res)=>{
    requireScannerLink(await getScannerLink(req.params.token));
    res.set('Cache-Control','no-store').json({ok:true,expiresIn:null});
  }));
  app.post('/api/v1/market/scanner/:token/scan', asyncRoute(async (req,res)=>{
    requireScannerLink(await getScannerLink(req.params.token));
    const barcode=String(req.body?.barcode||'').trim();if(!barcode||barcode.length>128)throw new AppError(400,'INVALID_BARCODE','باركود غير صالح');
    const code={barcode,at:new Date().toISOString()};
    if(scannerCollection){const result=await scannerCollection.updateOne({_id:req.params.token,revoked:false},{$push:{codes:{$each:[code],$slice:-100}}});if(!result.matchedCount)requireScannerLink(null);}
    else{const link=requireScannerLink(marketScannerLinks.get(req.params.token));link.codes.push(code);if(link.codes.length>100)link.codes.splice(0,link.codes.length-100);}
    res.json({ok:true});
  }));
  app.get('/api/v1/market/scanner/:token/poll', authenticate(store), permit('sync.use'), asyncRoute(async (req,res)=>{
    const link=requireScannerLink(await getScannerLink(req.params.token));if(link.companyId!==req.auth.company.id)requireScannerLink(null);
    let codes;
    if(scannerCollection){const old=await scannerCollection.findOneAndUpdate({_id:req.params.token,companyId:req.auth.company.id,revoked:false},{$set:{codes:[]}},{returnDocument:'before'});requireScannerLink(old);codes=old.codes||[];}
    else codes=link.codes.splice(0);
    res.set('Cache-Control','no-store').json({codes});
  }));
  app.post('/api/v1/market/scanner/disconnect', authenticate(store), permit('sync.use'), asyncRoute(async (req,res)=>{
    const shiftId=uuid(req.body?.shiftId,'shiftId');await revokeScannerShift(req.auth.company.id,shiftId);res.json({ok:true});
  }));

  app.post('/api/v1/market/sale', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length || lines.length > 500) throw new AppError(400, 'INVALID_MARKET_SALE', 'فاتورة البيع غير صالحة');
    let cursor = 0, latestRow = null, guard = 0;
    do {
      const page = await store.pullChanges(req.auth.company.id, cursor, 500);
      for (const row of page.changes || []) if (row.entityType === 'market.snapshot') latestRow = row;
      if (!page.hasMore || page.nextCursor === cursor) break;
      cursor = page.nextCursor; guard += 1;
    } while (guard < 200);
    const latest = latestRow?.payload || latestRow?.data || null;
    if (!latest?.catalog) throw new AppError(409, 'MARKET_CATALOG_NOT_SYNCED', 'يجب مزامنة مخزون الحاسبة الرئيسية أولًا');
    const catalog = structuredClone(latest.catalog);
    for (const line of lines) {
      const item = catalog.find((x) => String(x.id) === String(line.itemId));
      const qty = Number(line.quantity || 0);
      if (!item || !(qty > 0)) throw new AppError(409, 'MARKET_ITEM_NOT_FOUND', 'أحد أصناف الفاتورة غير موجود');
      if (Number(item.qty || 0) < qty) throw new AppError(409, 'MARKET_STOCK_INSUFFICIENT', 'الرصيد غير كافٍ للصنف: ' + String(item.name || ''));
    }
    for (const line of lines) {
      const item = catalog.find((x) => String(x.id) === String(line.itemId));
      item.qty = Number(item.qty || 0) - Number(line.quantity || 0);
    }
    const now = new Date().toISOString(), snapshotOperation = validateOperation({
      operationId: randomUUID(), deviceId: String(req.auth.session.deviceId || 'market-web'),
      clientSequence: Date.now(), occurredAt: now, schemaVersion: 1, dependencies: [], type: 'market.snapshot',
      payload: { catalog, updatedAt: now }
    });
    const saleId = String(req.body?.id || randomUUID()), saleOperation = validateOperation({
      operationId: randomUUID(), deviceId: String(req.auth.session.deviceId || 'market-web'),
      clientSequence: Date.now() + 1, occurredAt: now, schemaVersion: 1, dependencies: [], type: 'market.transaction.sale',
      payload: { ...req.body, id: saleId, kind: 'sale', occurredAt: now }
    });
    const results = await store.pushOperations(req.auth, [snapshotOperation, saleOperation]);
    if (results.some((x) => x.status !== 'acknowledged')) throw new AppError(409, 'MARKET_SALE_REJECTED', 'تعذر اعتماد البيع مركزيًا');
    res.json({ ok: true, saleId, snapshot: { catalog, updatedAt: now } });
  }));

  app.get('/api/v1/market/cashier-events', authenticate(store), permit('sync.use'), asyncRoute(async(req,res)=>{
    const cursor=Math.max(0,Number.parseInt(req.query.cursor||'0',10)||0),page=await store.pullChanges(req.auth.company.id,cursor,500);
    res.set('Cache-Control','no-store').json({events:(page.changes||[]).filter(x=>x.entityType==='market.transaction').map(x=>x.payload||x.data),nextCursor:page.nextCursor,hasMore:page.hasMore});
  }));

  app.get('/api/v1/market/transactions', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    let cursor = 0, rows = [], guard = 0;
    do {
      const page = await store.pullChanges(req.auth.company.id, cursor, 500);
      rows.push(...(page.changes || []).filter((row) => row.entityType === 'market.transaction').map((row) => row.payload || row.data).filter(Boolean));
      if (!page.hasMore || page.nextCursor === cursor) break;
      cursor = page.nextCursor; guard += 1;
    } while (guard < 200);
    res.json({ transactions: rows.slice(-5000) });
  }));

  app.get('/api/v1/market/snapshot', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    let cursor = 0, latest = null, guard = 0;
    do {
      const page = await store.pullChanges(req.auth.company.id, cursor, 500);
      for (const row of page.changes || []) if (row.entityType === 'market.snapshot') latest = row;
      if (!page.hasMore || page.nextCursor === cursor) break;
      cursor = page.nextCursor; guard += 1;
    } while (guard < 200);
    res.json({ snapshot: latest?.payload || latest?.data || null });
  }));

  app.post('/api/v1/market/snapshot', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    let cursor = 0, latestRow = null, guard = 0;
    do {
      const page = await store.pullChanges(req.auth.company.id, cursor, 500);
      for (const row of page.changes || []) if (row.entityType === 'market.snapshot') latestRow = row;
      if (!page.hasMore || page.nextCursor === cursor) break;
      cursor = page.nextCursor; guard += 1;
    } while (guard < 200);
    const latest = latestRow?.payload || latestRow?.data || null;
    const baseUpdatedAt = req.body?.baseUpdatedAt == null ? null : String(req.body.baseUpdatedAt);
    if (latest?.updatedAt && baseUpdatedAt !== String(latest.updatedAt)) {
      return res.status(409).json({ ok:false, code:'MARKET_SNAPSHOT_CONFLICT', message:'تم تعديل المخزون من جهاز آخر', snapshot:latest });
    }
    const catalog = Array.isArray(req.body?.catalog) ? req.body.catalog.slice(0, 10000).map((x) => ({
      id: String(x.id || '').slice(0,128), name: String(x.name || '').slice(0,200),
      category: String(x.category || 'غير مصنف').slice(0,100), barcode: String(x.barcode || '').slice(0,64),
      cost: Number(x.cost || 0), price: Number(x.price || 0), qty: Number(x.qty || 0),
      minQty: Number(x.minQty || 0), unit: String(x.unit || 'قطعة').slice(0,32), demo: x.demo === true
    })) : null;
    if (!catalog) throw new AppError(400, 'INVALID_MARKET_CATALOG', 'بيانات أصناف الماركت غير صالحة');
    const operation = validateOperation({
      operationId: randomUUID(), deviceId: String(req.auth.session.deviceId || 'market-web'),
      clientSequence: Date.now(), occurredAt: new Date().toISOString(), schemaVersion: 1,
      dependencies: [], type: 'market.snapshot', payload: { catalog, updatedAt: String(req.body?.clientUpdatedAt || new Date().toISOString()) }
    });
    const results = await store.pushOperations(req.auth, [operation]);
    res.json({ ok: true, result: results[0] });
  }));

  app.get('/api/v1/enterprise/reports', authenticate(store), permit('accounting.read'), asyncRoute(async (req, res) => {
    const data = await store.listEnterpriseData(req.auth.company.id);
    if (!req.auth.permissions.includes('users.manage')) delete data.users;
    res.json(data);
  }));
  app.post('/api/v1/enterprise/transfers', authenticate(store), permit('inventory.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['operationId','sourceWarehouseId','destinationWarehouseId','transferNumber']);
    if (!Array.isArray(req.body.lines) || !req.body.lines.length || req.body.lines.length > 500) throw new AppError(400,'LINES_REQUIRED','بنود التحويل مطلوبة');
    res.status(201).json({ transfer: await store.transferEnterpriseStock(req.auth, {
      operationId: uuid(req.body.operationId,'operationId'), occurredAt: new Date().toISOString(), transferNumber: String(req.body.transferNumber).slice(0,64),
      sourceWarehouseId: uuid(req.body.sourceWarehouseId,'sourceWarehouseId'), destinationWarehouseId: uuid(req.body.destinationWarehouseId,'destinationWarehouseId'),
      lines: req.body.lines.map(line => ({ itemId: uuid(line.itemId,'itemId'), quantity: decimalInput(line.quantity,{positive:true}) }))
    }) });
  }));
  app.post('/api/v1/enterprise/settlements', authenticate(store), permit('accounting.post'), asyncRoute(async (req, res) => {
    requireFields(req.body,['operationId','documentId','amount','receiptNumber','method']);
    if (!['cash','bank'].includes(req.body.method)) throw new AppError(400,'INVALID_METHOD','طريقة الدفع غير صالحة');
    res.status(201).json({ settlement: await store.settleEnterpriseDocument(req.auth, {
      operationId: uuid(req.body.operationId,'operationId'), documentId: uuid(req.body.documentId,'documentId'), amount: decimalInput(req.body.amount,{positive:true}),
      receiptNumber: String(req.body.receiptNumber).slice(0,64), method: req.body.method, occurredAt: new Date().toISOString()
    }) });
  }));
  app.get('/api/v1/enterprise/backup', authenticate(store), permit('company.manage'), asyncRoute(async (req, res) => {
    if (typeof store.exportBackup !== 'function') throw new AppError(400,'LOCAL_BACKUP_ONLY','النسخ الاحتياطي هنا خاص بقاعدة الجهاز');
    res.setHeader('Content-Disposition','attachment; filename="AlMahasibPro-backup.sqlite"');
    res.type('application/octet-stream').send(await store.exportBackup());
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


