import { installSalesRoutes, salesRep, salesScoped } from './sales-workspace.js';
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

export function createApp({ store, sessionDays = 14, secureCookies = false, allowedOrigins = [], cookieName = 'almahasib_session', cookiePath = '/' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { req.sessionCookieName = cookieName; next(); });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'المصدر غير مسموح'));
    },
    credentials: true
  }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(publicDirectory, { extensions: ['html'], etag: true }));

  installSalesRoutes(app,{store,authenticate,permit,validateDocument:validateCommercePayload});
  app.get('/api/v1/health', (req, res) => res.json({ status: 'ok', service: 'almahasib-pro' }));

  app.post('/api/v1/companies/register', asyncRoute(async (req, res) => {
    requireFields(req.body, ['legalName', 'ownerName', 'phone', 'username', 'password']);
    const passwordHash = await passwordHashOrValidation(req.body.password);
    const company = await store.registerCompany({
      code: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`,
      legalName: req.body.legalName.trim(),
      timezone: req.body.timezone || 'Asia/Baghdad',
      currency: ['IQD','USD'].includes(String(req.body.currency||'IQD').toUpperCase()) ? String(req.body.currency||'IQD').toUpperCase() : 'IQD',
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

  app.get('/api/v1/auth/roles', asyncRoute(async (req, res) => {
    const code = normalizeCode(req.query.companyCode);
    res.json({ roles: store.listLoginRoles ? await store.listLoginRoles(code) : [] });
  }));

  app.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
    requireFields(req.body, ['username', 'password']);
    const platform = req.body.platform === true;
    if (!platform && !String(req.body.companyCode || '').trim()) {
      throw new AppError(400, 'COMPANY_CODE_REQUIRED', 'رمز الشركة مطلوب');
    }
    const attemptKey = `${cookieName}:${req.ip}:${String(req.body.companyCode || 'platform')}:${String(req.body.username).toLowerCase()}`;
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
    if (!platform && req.body.roleCode) {
      if (!store.listUsers) throw new AppError(501, 'STORE_UNSUPPORTED', 'اختيار الدور غير متاح لهذا الخادم');
      const user = (await store.listUsers(login.company.id)).find(row => row.id === login.user.id);
      if (user?.roleCode !== req.body.roleCode) throw new AppError(403, 'LOGIN_ROLE_MISMATCH', 'الدور المختار لا يطابق دور حسابك؛ اختر الدور الذي حدده المدير');
    }
    loginAttempts.delete(attemptKey);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + sessionDays * 86400000).toISOString();
    await store.createSession({
      tokenHash: hashToken(token), userId: login.user.id,
      deviceId: String(req.body.deviceId || 'web-browser').slice(0, 128), expiresAt
    });
    setSessionCookie(res, token, sessionDays, secureCookies, cookieName, cookiePath);
    const context = await store.getSessionContext(hashToken(token));
    res.json({ token, expiresAt, account: publicContext(context) });
  }));

  app.post('/api/v1/auth/logout', authenticate(store), asyncRoute(async (req, res) => {
    await store.revokeSession(req.auth.tokenHash, req.auth.user.id);
    res.setHeader('Set-Cookie', `${cookieName}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`);
    res.status(204).end();
  }));

  app.patch('/api/v1/company/accounting-settings', authenticate(store), permit('company.manage'), asyncRoute(async (req,res)=>{
    const baseCurrency=currency(req.body.baseCurrency||req.auth.company.currency||'IQD');
    if(!['IQD','USD'].includes(baseCurrency)) throw new AppError(400,'INVALID_CURRENCY','اختر الدينار العراقي أو الدولار الأمريكي');
    const company=await store.updateCompanyAccountingSettings(req.auth.company.id,{baseCurrency,usdToIqdRate:decimalInput(req.body.usdToIqdRate,{positive:true})},req.auth.user.id);
    res.json({company});
  }));

  app.get('/api/v1/bootstrap', authenticate(store), (req, res) => {
    res.json({
      ...publicContext(req.auth),
      salesProfile:store.salesSettings?.get('user:'+req.auth.user.id)||null,
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
      salesProfile: req.body.salesProfile, status:req.body.status, permissions: req.body.permissions, scopes: validateScopes(req.body.scopes, req.auth.company)
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
      roleCode: req.body.roleCode, status: req.body.status, permissions: req.body.permissions, salesProfile: req.body.salesProfile,
      passwordHash: req.body.password ? await passwordHashOrValidation(req.body.password) : undefined
    }, req.auth.user.id) });
  }));

  app.get('/api/v1/accounting/chart', authenticate(store), permit('accounting.read'), asyncRoute(async (req,res)=>{ res.json({accounts:store.listChartAccounts(req.auth.company.id)}); }));
  app.post('/api/v1/accounting/chart', authenticate(store), permit('accounting.post'), asyncRoute(async (req,res)=>{ res.status(201).json({account:await store.createChartAccount(req.auth.company.id,req.body||{},req.auth.user.id)}); }));
  app.post('/api/v1/accounting/journals', authenticate(store), permit('accounting.post'), asyncRoute(async (req,res)=>{
    requireFields(req.body,['operationId','entryNumber','occurredAt']);
    if(!Array.isArray(req.body.lines)||req.body.lines.length<2||req.body.lines.length>500) throw new AppError(400,'JOURNAL_LINES_REQUIRED','القيد يحتاج من سطرين إلى ٥٠٠ سطر');
    res.status(201).json({journal:await store.postManualJournal(req.auth,{...req.body,currency:req.body.currency||req.auth.company.currency})});
  }));
  app.post('/api/v1/accounting/journals/:journalId/reverse', authenticate(store), permit('accounting.post'), asyncRoute(async (req,res)=>{
    requireFields(req.body,['operationId','entryNumber','occurredAt']);
    res.status(201).json({journal:await store.reverseJournal(req.auth,req.params.journalId,req.body)});
  }));

  app.get('/api/v1/master-data', authenticate(store), permitAny(['catalog.read', 'customers.read', 'suppliers.read', 'inventory.read']), asyncRoute(async (req, res) => {
    const m=await store.listMasterData(req.auth.company.id);
    if(salesScoped(store,req.auth)&&store.salesSettings){const channel=store.salesSettings.get('user:'+req.auth.user.id)?.channel||'retail';m.customers=m.customers.filter(x=>(store.salesSettings.get('customer:'+x.id)?.channel||'retail')===channel);m.suppliers=[];m.prices=m.prices.filter(x=>['sale','sale_'+channel].includes(x.priceType));m.stock=m.stock.map(({averageCost,...x})=>x);}
    res.json(m);
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

  app.post('/api/v1/catalog/categories', authenticate(store), permit('catalog.manage'), asyncRoute(async(req,res)=>{res.status(201).json({category:await store.createItemCategory(req.auth.company.id,req.body.name,req.auth.user.id)});}));
  app.post('/api/v1/catalog/items', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['sku', 'name', 'baseUnitId']);
    if(req.body.category&&!((await store.listItemCategories(req.auth.company.id)).includes(req.body.category)))throw new AppError(400,'INVALID_CATEGORY','اختر تصنيفًا موجودًا أو أضفه أولًا');
    const item = await store.createItem(req.auth.company.id, {
      sku: entityCode(req.body.sku), name: req.body.name.trim(), category: req.body.category||'', description: typeof req.body.description==='string'?req.body.description:'', baseUnitId: uuid(req.body.baseUnitId, 'baseUnitId')
    }, req.auth.user.id);
    res.status(201).json({ item });
  }));

  app.get('/api/v1/catalog/items/:itemId/details', authenticate(store), permit('catalog.read'), asyncRoute(async(req,res)=>{
    const item=store.items.get(uuid(req.params.itemId,'itemId'));if(!item||item.companyId!==req.auth.company.id)throw new AppError(404,'ITEM_NOT_FOUND','المادة غير موجودة');
    const {photos,...details}=store.salesSettings?.get('item:'+item.id)||{};res.json({item:{...details,...item}});
  }));
  app.patch('/api/v1/catalog/items/:itemId', authenticate(store), permit('catalog.manage'), asyncRoute(async(req,res)=>{
    if(typeof req.body.description!=='string'||req.body.description.length>4000)throw new AppError(400,'INVALID_DESCRIPTION','الوصف نص بحد أقصى 4000 حرف');
    res.json({item:await store.updateItemDescription(req.auth.company.id,uuid(req.params.itemId,'itemId'),req.body.description,req.auth.user.id)});
  }));
  app.delete('/api/v1/catalog/items/:itemId', authenticate(store), permit('catalog.manage'), asyncRoute(async(req,res)=>{
    res.json(await store.deleteUnusedItem(req.auth.company.id,uuid(req.params.itemId,'itemId'),req.auth.user.id));
  }));

  app.post('/api/v1/catalog/items/:itemId/units', authenticate(store), permit('catalog.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['unitId', 'conversionFactor']);
    const itemUnit = await store.addItemUnit(req.auth.company.id, uuid(req.params.itemId, 'itemId'), {
      unitId: uuid(req.body.unitId, 'unitId'), conversionFactor: decimalInput(req.body.conversionFactor, { positive: true })
    }, req.auth.user.id);
    res.status(201).json({ itemUnit });
  }));

  app.post('/api/v1/catalog/prices', authenticate(store), (req,res,next)=>req.auth.permissions.includes('catalog.manage')||req.auth.permissions.includes('purchasing.approve')?next():next(new AppError(403,'FORBIDDEN','تحتاج صلاحية إدارة الأصناف أو اعتماد المشتريات')), asyncRoute(async (req, res) => {
    requireFields(req.body, ['itemId', 'unitId', 'priceType', 'currency', 'amount']);
    if (!['sale', 'sale_retail', 'sale_wholesale', 'purchase'].includes(req.body.priceType)) throw new AppError(400, 'INVALID_PRICE_TYPE', 'نوع السعر غير صالح');
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
      creditLimit: decimalInput(req.body.creditLimit || '0', { nonNegative: true }),
      province: String(req.body.province || '').trim().slice(0, 80),
      district: String(req.body.district || '').trim().slice(0, 100),
      address: String(req.body.address || '').trim().slice(0, 240),
      paymentPreference: ['cash', 'credit', 'mixed'].includes(req.body.paymentPreference) ? req.body.paymentPreference : 'cash',
      salesChannel: req.body.salesChannel === 'wholesale' ? 'wholesale' : 'retail'
    }, req.auth.user.id);
    res.status(201).json({ customer });
  }));

  app.patch('/api/v1/customers/:id', authenticate(store), permit('customers.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    const input = {
      code: entityCode(req.body.code), name: String(req.body.name).trim(),
      phone: String(req.body.phone || '').trim().slice(0, 40),
      province: String(req.body.province || '').trim().slice(0, 80),
      district: String(req.body.district || '').trim().slice(0, 100),
      address: String(req.body.address || '').trim().slice(0, 240),
      creditLimit: decimalInput(req.body.creditLimit || '0', { nonNegative: true }),
      paymentPreference: ['cash', 'credit', 'mixed'].includes(req.body.paymentPreference) ? req.body.paymentPreference : 'cash',
      salesChannel: req.body.salesChannel === 'wholesale' ? 'wholesale' : 'retail'
    };
    if (typeof req.body.active === 'boolean') input.active = req.body.active;
    const customer = await store.updateCustomer(req.auth.company.id, req.params.id, input, req.auth.user.id);
    res.json({customer});
  }));

  app.delete('/api/v1/customers/:id', authenticate(store), permit('customers.manage'), asyncRoute(async (req, res) => {
    res.json(await store.deleteCustomer(req.auth.company.id, req.params.id, req.auth.user.id));
  }));

  app.post('/api/v1/suppliers', authenticate(store), permit('suppliers.manage'), asyncRoute(async (req, res) => {
    requireFields(req.body, ['code', 'name']);
    const supplier = await store.createParty(req.auth.company.id, 'supplier', {
      code: entityCode(req.body.code), name: req.body.name.trim(), phone: req.body.phone,
      country: String(req.body.country || '').trim().slice(0,120),
      companyName: String(req.body.companyName || '').trim().slice(0,200),
      specialty: String(req.body.specialty || '').trim().slice(0,200),
      relationshipStartYear: String(req.body.relationshipStartYear || '').trim().slice(0,4)
    }, req.auth.user.id);
    res.status(201).json({ supplier });
  }));

  app.patch('/api/v1/suppliers/:id', authenticate(store), permit('suppliers.manage'), asyncRoute(async (req, res) => {
    const supplier = await store.updateSupplier(req.auth.company.id, uuid(req.params.id, 'supplierId'), {
      code: req.body.code ? entityCode(req.body.code) : undefined,
      name: req.body.name ? String(req.body.name).trim().slice(0, 200) : undefined,
      phone: req.body.phone === undefined ? undefined : String(req.body.phone || '').trim().slice(0, 50),
      country: req.body.country === undefined ? undefined : String(req.body.country || '').trim().slice(0, 120),
      companyName: req.body.companyName === undefined ? undefined : String(req.body.companyName || '').trim().slice(0, 200),
      specialty: req.body.specialty === undefined ? undefined : String(req.body.specialty || '').trim().slice(0, 200),
      relationshipStartYear: req.body.relationshipStartYear === undefined ? undefined : String(req.body.relationshipStartYear || '').trim().slice(0, 4)
    }, req.auth.user.id);
    res.json({ supplier });
  }));

  app.delete('/api/v1/suppliers/:id', authenticate(store), permit('suppliers.manage'), asyncRoute(async (req, res) => {
    res.json({ deleted: await store.deleteSupplier(req.auth.company.id, uuid(req.params.id, 'supplierId'), req.auth.user.id) });
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
    const data=await store.getRepresentativeBootstrap(req.auth,req.query.representativeId?uuid(req.query.representativeId,'representativeId'):null);
    if(salesScoped(store,req.auth)&&store.salesSettings){const channel=store.salesSettings.get('user:'+req.auth.user.id)?.channel||'retail';data.customers=data.customers.filter(x=>(store.salesSettings.get('customer:'+x.id)?.channel||'retail')===channel);const ids=new Set(data.customers.map(x=>x.id));data.orders=(data.orders||[]).filter(x=>ids.has(x.customerId));if(data.catalog?.prices)data.catalog.prices=data.catalog.prices.filter(x=>['sale','sale_'+channel].includes(x.priceType));data.routes=(data.routes||[]).map(x=>({...x,stops:(x.stops||[]).filter(y=>ids.has(y.customerId))}));}
    res.json(data);
  }));

  app.post('/api/v1/representatives/operations', authenticate(store), asyncRoute(async (req, res) => {
    const operation = validateOperation({ operationId: req.body.operationId, deviceId: req.body.deviceId, clientSequence: req.body.clientSequence, occurredAt: req.body.occurredAt, schemaVersion: 1, dependencies: req.body.dependencies || [], type: req.body.type, payload: validateRepresentativePayload(req.body.type, req.body.payload) });
    if(salesRep(req.auth)&&store.salesSettings?.has('user:'+req.auth.user.id))throw new AppError(403,'USE_SALES_WORKSPACE','استخدم صفحة المبيعات الحالية');
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
    let documents=await store.listCommerceDocuments(req.auth.company.id);
    if(salesScoped(store,req.auth)&&store.salesSettings){const channel=store.salesSettings.get('user:'+req.auth.user.id)?.channel||'retail';documents=documents.filter(x=>x.documentType.startsWith('sale')&&x.customerId&&(store.salesSettings.get('customer:'+x.customerId)?.channel||'retail')===channel).map(x=>({...x,lines:x.lines.map(({unitCost,...line})=>line)}));}
    res.json({documents});
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
      if (operation.type === 'commerce.commit') { operation.payload=validateCommercePayload(operation.payload);operation.payloadHash=payloadHash(operation.payload);requireCommercePermission(req.auth, operation.payload.documentType); }
      if (operation.type.startsWith('pos.')) requirePosPermission(req.auth, operation.type);
      if (operation.type.startsWith('representative.')) { if(salesRep(req.auth)&&store.salesSettings?.has('user:'+req.auth.user.id))throw new AppError(403,'USE_SALES_WORKSPACE','استخدم صفحة المبيعات الحالية');operation.payload = validateRepresentativePayload(operation.type, operation.payload); requireRepresentativePermission(req.auth, operation.type); }
    }
    const results = await store.pushOperations(req.auth, operations);
    for(const operation of operations){if(operation.type==='market.transaction.shift_close'&&results.some(r=>r.operationId===operation.operationId&&r.status==='acknowledged'))await revokeScannerShift(req.auth.company.id,operation.payload.shiftId);}
    res.json({ results });
  }));

  app.get('/api/v1/sync/pull', authenticate(store), permit('sync.use'), asyncRoute(async (req, res) => {
    const cursor = Math.max(0, Number.parseInt(req.query.cursor || '0', 10) || 0);
    const page=await store.pullChanges(req.auth.company.id,cursor,100);
    if(salesScoped(store,req.auth)&&store.salesSettings){const channel=store.salesSettings.get('user:'+req.auth.user.id)?.channel||'retail';page.changes=page.changes.filter(x=>x.entityType==='unit'||x.entityType==='item'||x.entityType==='item_unit'||(x.entityType==='price'&&['sale','sale_'+channel].includes(x.payload?.priceType))||(x.entityType==='customer'&&(store.salesSettings.get('customer:'+x.entityId)?.channel||'retail')===channel));}
    res.json(page);
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
    if (!['cash','bank','bank_transfer','check'].includes(req.body.method)) throw new AppError(400,'INVALID_METHOD','طريقة الدفع غير صالحة');
    const receivedCurrency = req.body.receivedCurrency || req.body.currency;
    res.status(201).json({ settlement: await store.settleEnterpriseDocument(req.auth, {
      operationId: uuid(req.body.operationId,'operationId'), documentId: uuid(req.body.documentId,'documentId'), amount: decimalInput(req.body.amount,{positive:true}),
      receiptNumber: String(req.body.receiptNumber).slice(0,64), method: req.body.method,
      bankName: String(req.body.bankName || '').trim().slice(0,160), transactionNumber: String(req.body.transactionNumber || '').trim().slice(0,120),
      receivedAmount: decimalInput(req.body.receivedAmount || req.body.amount,{positive:true}), receivedCurrency: receivedCurrency ? currency(receivedCurrency) : undefined,
      exchangeRate: decimalInput(req.body.exchangeRate || '1',{positive:true}),
      occurredAt: /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paymentDate||'')) ? new Date(req.body.paymentDate+'T12:00:00.000Z').toISOString() : new Date().toISOString()
    }) });
  }));
  app.get('/api/v1/enterprise/backup', authenticate(store), permit('company.manage'), asyncRoute(async (req, res) => {
    if (typeof store.exportBackup !== 'function') throw new AppError(400,'LOCAL_BACKUP_ONLY','النسخ الاحتياطي هنا خاص بقاعدة الجهاز');
    res.setHeader('Content-Disposition','attachment; filename="AlMahasibPro-backup.sqlite"');
    res.type('application/octet-stream').send(await store.exportBackup());
  }));

  async function wholesaleRecords(companyId) {
    const latest = new Map(); let cursor = 0, guard = 0;
    do {
      const page = await store.pullChanges(companyId, cursor, 500);
      for (const row of page.changes || []) {
        const payload = row.payload || row.data || {};
        if (row.entityType === 'draft' && payload.feature === 'wholesale-invoice' && payload.entityId) latest.set(String(payload.entityId), payload);
      }
      if (!page.hasMore || page.nextCursor === cursor) break;
      cursor = page.nextCursor; guard += 1;
    } while (guard < 200);
    return latest;
  }
  async function saveWholesaleRecord(context, record) {
    const now = new Date().toISOString();
    const operation = validateOperation({
      operationId: randomUUID(), deviceId: String(context.session.deviceId || 'wholesale-web'),
      clientSequence: Date.now() + Math.floor(Math.random() * 100000), occurredAt: now,
      schemaVersion: 1, dependencies: [], type: 'draft.wholesale_invoice',
      payload: { ...record, feature: 'wholesale-invoice', updatedAt: now, updatedBy: context.user.id }
    });
    const [result] = await store.pushOperations(context, [operation]);
    if (result.status !== 'acknowledged') throw new AppError(409, result.code || 'INVOICE_SAVE_FAILED', result.message || 'تعذر حفظ الفاتورة');
    return operation.payload;
  }
  const invoiceTemplates = ['classic', 'modern', 'trade', 'minimal', 'luxury'];
  const defaultInvoiceSettings = (company) => ({ entityId: 'wholesale-settings', feature: 'wholesale-invoice', recordType: 'settings', template: 'classic', commercialName: company?.legalName || '', logo: '', address: company?.address || '', phone: company?.phone || '', registration: '', footer: 'شكرًا لتعاملكم معنا', signatory: '' });

  app.get('/api/v1/wholesale/invoices', authenticate(store), permitAny(['sales.read', 'sales.wholesale.submit', 'sales.retail.submit', 'sales.wholesale.review', 'sales.wholesale.finalize']), asyncRoute(async (req, res) => {
    const records = await wholesaleRecords(req.auth.company.id);
    let invoices = [...records.values()].filter((x) => x.recordType === 'invoice').map((x) => x.invoice);
    const canReview = req.auth.permissions.includes('sales.wholesale.review') || req.auth.permissions.includes('sales.wholesale.finalize') || req.auth.permissions.includes('sales.invoice.template.manage');
    if (!canReview) invoices = invoices.filter((x) => x.createdBy === req.auth.user.id);
    invoices.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ invoices });
  }));

  app.get('/api/v1/wholesale/accounts', authenticate(store), permitAny(['sales.read', 'sales.wholesale.submit', 'sales.retail.submit', 'sales.wholesale.review', 'sales.wholesale.finalize']), asyncRoute(async (req, res) => {
    res.json({ accounts: await store.listCustomerAccountSummaries(req.auth.company.id) });
  }));

  app.get('/api/v1/wholesale/settings', authenticate(store), permitAny(['sales.read', 'sales.wholesale.submit', 'sales.retail.submit', 'sales.wholesale.review', 'sales.wholesale.finalize']), asyncRoute(async (req, res) => {
    const records = await wholesaleRecords(req.auth.company.id);
    const row = records.get('wholesale-settings');
    res.json({ settings: row?.recordType === 'settings' ? row.settings : defaultInvoiceSettings(req.auth.company) });
  }));

  app.post('/api/v1/wholesale/settings', authenticate(store), permit('sales.invoice.template.manage'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    if (!invoiceTemplates.includes(String(b.template || ''))) throw new AppError(400, 'INVALID_INVOICE_TEMPLATE', 'قالب الفاتورة غير صالح');
    const logo = String(b.logo || '');
    if (logo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > 1400000)) throw new AppError(400, 'INVALID_INVOICE_LOGO', 'ارفع شعارًا بصيغة PNG أو JPG أو WebP بحجم لا يتجاوز 1MB');
    const settings = {
      entityId: 'wholesale-settings', recordType: 'settings', template: String(b.template),
      commercialName: String(b.commercialName || '').trim().slice(0, 140), logo,
      address: String(b.address || '').trim().slice(0, 240), phone: String(b.phone || '').trim().slice(0, 48),
      registration: String(b.registration || '').trim().slice(0, 80), footer: String(b.footer || '').trim().slice(0, 240),
      signatory: String(b.signatory || '').trim().slice(0, 100)
    };
    await saveWholesaleRecord(req.auth, { entityId: 'wholesale-settings', recordType: 'settings', settings });
    res.json({ settings });
  }));

  app.post('/api/v1/wholesale/invoices', authenticate(store), asyncRoute(async (req, res) => {
    const b = req.body || {}, repType = String(b.representativeType || '');
    const submitPermission = repType === 'wholesale' ? 'sales.wholesale.submit' : repType === 'retail' ? 'sales.retail.submit' : '';
    if (!submitPermission || !req.auth.permissions.includes(submitPermission)) throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لهذا النوع من المبيعات');
    requireFields(b, ['customerId', 'warehouseId', 'currency', 'paymentType']);
    if (!['cash', 'credit', 'mixed'].includes(b.paymentType)) throw new AppError(400, 'INVALID_PAYMENT_TYPE', 'نوع الدفع غير صالح');
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 300) throw new AppError(400, 'DOCUMENT_LINES_REQUIRED', 'أضف صنفًا واحدًا على الأقل');
    const master = await store.listMasterData(req.auth.company.id);
    const customer = master.customers.find((x) => x.id === uuid(b.customerId, 'customerId'));
    const warehouse = master.warehouses.find((x) => x.id === uuid(b.warehouseId, 'warehouseId') && x.active !== false);
    if (!customer || !warehouse) throw new AppError(400, 'CUSTOMER_OR_WAREHOUSE_NOT_FOUND', 'العميل أو المخزن المحدد غير موجود');
    const warehouseScopes = (req.auth.scopes || []).filter((x) => x.type === 'warehouse');
    if (warehouseScopes.length && !warehouseScopes.some((x) => x.id === warehouse.id)) throw new AppError(403, 'WAREHOUSE_SCOPE_DENIED', 'المخزن خارج نطاق حسابك');
    const branchScopes = (req.auth.scopes || []).filter((x) => x.type === 'branch');
    if (branchScopes.length && !branchScopes.some((x) => x.id === warehouse.branchId)) throw new AppError(403, 'BRANCH_SCOPE_DENIED', 'الفرع خارج نطاق حسابك');
    const customerScopes = (req.auth.scopes || []).filter((x) => x.type === 'customers');
    if (customerScopes.length && !customerScopes.some((x) => x.id === customer.id)) throw new AppError(403, 'CUSTOMER_SCOPE_DENIED', 'العميل خارج نطاق حسابك');
    const lines = b.lines.map((line) => {
      const itemId = uuid(line.itemId, 'itemId'), unitId = uuid(line.unitId, 'unitId');
      const item = master.items.find((x) => x.id === itemId);
      if (!item || !(item.units || []).some((u) => (u.unitId || u.id) === unitId)) throw new AppError(400, 'INVOICE_ITEM_NOT_FOUND', 'أحد الأصناف أو وحداته غير موجود');
      const quantity = decimalInput(line.quantity, { positive: true });
      const unitPrice = decimalInput(line.unitPrice, { nonNegative: true });
      const unit = master.units.find((x) => x.id === unitId);
      return { itemId, unitId, sku: item.sku, name: item.name, unitName: unit?.name || '', quantity, unitPrice, lineTotal: decimalString(decimal(quantity) * decimal(unitPrice) / 1000000n) };
    });
    const subtotal = lines.reduce((sum, line) => sum + decimal(line.lineTotal), 0n);
    const discountAmount = decimalInput(b.discountAmount || '0', { nonNegative: true });
    const total = subtotal - decimal(discountAmount);
    if (total < 0n) throw new AppError(400, 'DISCOUNT_EXCEEDS_TOTAL', 'الخصم أكبر من إجمالي الفاتورة');
    const paidAmount = decimalInput(b.paidAmount || '0', { nonNegative: true });
    if (decimal(paidAmount) > total || (b.paymentType === 'cash' && decimal(paidAmount) !== total) || (b.paymentType === 'credit' && decimal(paidAmount) !== 0n) || (b.paymentType === 'mixed' && (decimal(paidAmount) <= 0n || decimal(paidAmount) >= total))) throw new AppError(400, 'INVALID_PAYMENT_AMOUNT', 'المبلغ المسدد لا يطابق نوع الدفع');
    const records = await wholesaleRecords(req.auth.company.id);
    const count = [...records.values()].filter((x) => x.recordType === 'invoice' && x.invoice?.representativeType === repType).length + 1;
    const createdAt = new Date().toISOString();
    const notes = String(b.internalNote || '').trim() ? [{ id: randomUUID(), text: String(b.internalNote).trim().slice(0, 1600), authorId: req.auth.user.id, authorName: req.auth.user.displayName, createdAt }] : [];
    const invoice = {
      id: randomUUID(), invoiceNumber: (repType === 'wholesale' ? 'WH' : 'RT') + '-' + String(count).padStart(6, '0'),
      representativeType: repType, representativeName: req.auth.user.displayName, createdBy: req.auth.user.id,
      customerId: customer.id, customerName: customer.name, customerPhone: customer.phone || '',
      customerProvince: customer.province || customer.governorate || '', customerDistrict: customer.district || customer.area || '',
      warehouseId: warehouse.id, warehouseName: warehouse.name, currency: currency(b.currency),
      paymentType: b.paymentType, paidAmount, outstandingAmount: decimalString(total - decimal(paidAmount)),
      lines, subtotal: decimalString(subtotal), discountAmount, total: decimalString(total),
      status: 'pending_wholesale_manager', notes, postingOperationId: randomUUID(),
      createdAt, createdByName: req.auth.user.displayName
    };
    await saveWholesaleRecord(req.auth, { entityId: invoice.id, recordType: 'invoice', invoice });
    res.status(201).json({ invoice });
  }));

  app.post('/api/v1/wholesale/invoices/:invoiceId/notes', authenticate(store), asyncRoute(async (req, res) => {
    const canNote = ['sales.wholesale.submit', 'sales.retail.submit', 'sales.wholesale.review', 'sales.wholesale.finalize'].some((p) => req.auth.permissions.includes(p));
    if (!canNote) throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لإضافة ملاحظة');
    const note = String(req.body?.note || '').trim();
    if (!note || note.length > 1600) throw new AppError(400, 'NOTE_REQUIRED', 'اكتب الملاحظة بحد أقصى 1600 حرف');
    const records = await wholesaleRecords(req.auth.company.id), current = records.get(String(req.params.invoiceId));
    if (!current?.invoice) throw new AppError(404, 'INVOICE_NOT_FOUND', 'الفاتورة غير موجودة');
    const invoice = structuredClone(current.invoice);
    const manager = req.auth.permissions.includes('sales.wholesale.review') || req.auth.permissions.includes('sales.wholesale.finalize');
    if (!manager && invoice.createdBy !== req.auth.user.id) throw new AppError(403, 'INVOICE_SCOPE_DENIED', 'لا يمكن تعديل فاتورة مستخدم آخر');
    invoice.notes = [...(invoice.notes || []), { id: randomUUID(), text: note, authorId: req.auth.user.id, authorName: req.auth.user.displayName, createdAt: new Date().toISOString() }];
    await saveWholesaleRecord(req.auth, { entityId: invoice.id, recordType: 'invoice', invoice });
    res.json({ invoice });
  }));

  async function finalizeWholesaleInvoice(context, invoice, decisionNote = '') {
    requireCommercePermission(context, 'sale');
    const document = {
      ...validateCommercePayload({
        documentType: 'sale', documentNumber: invoice.invoiceNumber, warehouseId: invoice.warehouseId,
        partyId: invoice.customerId, originalDocumentId: null, currency: invoice.currency,
        lines: invoice.lines.map((line) => ({ itemId: line.itemId, unitId: line.unitId, originalLineId: null, quantity: line.quantity, unitPrice: line.unitPrice })),
        payments: decimal(invoice.paidAmount) > 0n ? [{ method: 'cash', amount: invoice.paidAmount, reference: invoice.invoiceNumber }] : []
      }),
      discountAmount: invoice.discountAmount
    };
    const operation = validateOperation({
      operationId: invoice.postingOperationId, deviceId: String(context.session.deviceId || 'wholesale-web'),
      clientSequence: Date.now() + Math.floor(Math.random() * 100000), occurredAt: invoice.createdAt,
      schemaVersion: 1, dependencies: [], type: 'commerce.commit', payload: document
    });
    const [posted] = await store.pushOperations(context, [operation]);
    if (posted.status !== 'acknowledged') throw new AppError(409, posted.code || 'INVOICE_POST_FAILED', posted.message || 'تعذر اعتماد المخزون؛ لم تُعتمد الفاتورة');
    const approved = structuredClone(invoice);
    approved.status = 'approved'; approved.approvedAt = new Date().toISOString(); approved.approvedBy = context.user.id;
    approved.approvedByName = context.user.displayName; approved.postedDocumentId = posted.document?.id || posted.entityId || null;
    if (decisionNote) approved.notes = [...(approved.notes || []), { id: randomUUID(), text: decisionNote.slice(0, 1600), authorId: context.user.id, authorName: context.user.displayName, createdAt: new Date().toISOString() }];
    return approved;
  }

  app.post('/api/v1/wholesale/invoices/:invoiceId/decision', authenticate(store), asyncRoute(async (req, res) => {
    const action = String(req.body?.action || ''), note = String(req.body?.note || '').trim();
    const manager = req.auth.permissions.includes('sales.wholesale.review');
    const generalManager = req.auth.permissions.includes('sales.wholesale.finalize');
    if (!manager && !generalManager) throw new AppError(403, 'PERMISSION_DENIED', 'لا توجد صلاحية لاعتماد الفواتير');
    const records = await wholesaleRecords(req.auth.company.id), row = records.get(String(req.params.invoiceId));
    if (!row?.invoice) throw new AppError(404, 'INVOICE_NOT_FOUND', 'الفاتورة غير موجودة');
    const invoice = structuredClone(row.invoice);
    if (manager && invoice.status === 'pending_wholesale_manager') {
      if (action === 'approve') {
        const approved = await finalizeWholesaleInvoice(req.auth, invoice);
        await saveWholesaleRecord(req.auth, { entityId: invoice.id, recordType: 'invoice', invoice: approved });
        return res.json({ invoice: approved });
      }
      if (action === 'forward' || action === 'return') {
        if (!note) throw new AppError(400, 'NOTE_REQUIRED', 'سبب التحويل أو الإرجاع إلزامي');
        invoice.notes = [...(invoice.notes || []), { id: randomUUID(), text: note.slice(0, 1600), authorId: req.auth.user.id, authorName: req.auth.user.displayName, createdAt: new Date().toISOString() }];
        invoice.status = action === 'forward' ? 'pending_general_manager' : 'returned';
        invoice.managerDecisionAt = new Date().toISOString(); invoice.managerDecisionBy = req.auth.user.id;
        await saveWholesaleRecord(req.auth, { entityId: invoice.id, recordType: 'invoice', invoice });
        return res.json({ invoice });
      }
    }
    if (generalManager && invoice.status === 'pending_general_manager') {
      if (action === 'approve') {
        const approved = await finalizeWholesaleInvoice(req.auth, invoice);
        await saveWholesaleRecord(req.auth, { entityId: invoice.id, recordType: 'invoice', invoice: approved });
        return res.json({ invoice: approved });
      }
      if (action === 'return') {
        if (!note) throw new AppError(400, 'NOTE_REQUIRED', 'سبب الإرجاع إلزامي');
        invoice.notes = [...(invoice.notes || []), { id: randomUUID(), text: note.slice(0, 1600), authorId: req.auth.user.id, authorName: req.auth.user.displayName, createdAt: new Date().toISOString() }];
        invoice.status = 'returned'; invoice.finalDecisionAt = new Date().toISOString(); invoice.finalDecisionBy = req.auth.user.id;
        await saveWholesaleRecord(req.auth, { entityId: invoice.id, recordType: 'invoice', invoice });
        return res.json({ invoice });
      }
    }
    throw new AppError(409, 'INVALID_INVOICE_TRANSITION', 'حالة الفاتورة لا تسمح بهذا الإجراء');
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
    const token = bearer || parseCookies(req.get('cookie'))[req.sessionCookieName || 'almahasib_session'];
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'تسجيل الدخول مطلوب');
    const tokenHash = hashToken(token);
    const context = await store.getSessionContext(tokenHash);
    if (!context) throw new AppError(401, 'SESSION_INVALID', 'الجلسة منتهية أو ملغاة');
    if (req.productScope && (context.company?.product || 'company') !== req.productScope) throw new AppError(401, 'PRODUCT_SESSION_SCOPE', 'جلسة الدخول لا تخص هذا المنتج');
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
    note: String(payload.note||'').trim().slice(0,2000),
    discountAmount: decimalInput(payload.discountAmount || '0', { nonNegative: true }),
    approvalId: payload.approvalId ? uuid(payload.approvalId,'approvalId') : null,
    delivery: validateDelivery(payload.delivery),
    lines: payload.lines.map((line) => ({
      itemId: uuid(line.itemId, 'itemId'), unitId: uuid(line.unitId, 'unitId'),
      note: String(line.note||'').trim().slice(0,1000),
      specifications: Object.fromEntries(Object.entries(line.specifications||{}).filter(([key])=>['itemNumber','tradeName','originCountry','factory','dimensions','colors'].includes(key)).map(([key,value])=>[key,String(value||'').trim().slice(0,300)])),
      warehouseId: line.warehouseId ? uuid(line.warehouseId, 'line.warehouseId') : null,
      originalLineId: isReturn ? uuid(line.originalLineId, 'originalLineId') : null,
      quantity: decimalInput(line.quantity, { positive: true }),
      ...(isReturn ? {} : { unitPrice: decimalInput(line.unitPrice, { nonNegative: true }),enteredUnitPrice:decimalInput(line.enteredUnitPrice??line.unitPrice,{nonNegative:true}),systemUnitPrice:decimalInput(line.systemUnitPrice??line.enteredUnitPrice??line.unitPrice,{nonNegative:true}),discountQuantity:decimalInput(line.discountQuantity||'0',{nonNegative:true}),discountPercent:decimalInput(line.discountPercent||'0',{nonNegative:true}) })
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
  if(documentType==='sale' && salesRep(context) && context.permissions.includes('sales.create'))return;
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

function setSessionCookie(res, token, days, secure, name, cookiePath) {
  const attributes = [`${name}=${encodeURIComponent(token)}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${days * 86400}`];
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



function validateDelivery(value={}) { const mode=value?.mode||'none';if(!['both','services','transport','none','immediate'].includes(mode))throw new AppError(400,'INVALID_DELIVERY','نوع النقل والخدمات غير صالح');const out={mode};if(['both','transport'].includes(mode)&&!value.deliveryAt)throw new AppError(400,'DELIVERY_DATE_REQUIRED','موعد التوصيل مطلوب');if(['both','services'].includes(mode)&&!value.serviceAt)throw new AppError(400,'SERVICE_DATE_REQUIRED','موعد الخدمات مطلوب');for(const key of ['deliveryAt','serviceAt']){if(value?.[key]){if(typeof value[key]!=='string'||!Number.isFinite(Date.parse(value[key])))throw new AppError(400,'INVALID_DELIVERY_DATE','موعد غير صالح');out[key]=new Date(value[key]).toISOString();}}return out;}
