import { checkSales, salesRep } from '../sales-workspace.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/http.js';
import { decimal, decimalString, divide, multiply, ZERO } from '../lib/decimal.js';
import { PERMISSIONS, ROLE_TEMPLATES } from '../permissions.js';

const clone = (value) => structuredClone(value);

export class MemoryStore {
  constructor() {
    this.companies = new Map();
    this.users = new Map();
    this.roles = new Map();
    this.sessions = new Map();
    this.operations = new Map();
    this.changes = [];
    this.audit = [];
    this.financialRecords = new Map();
    this.units = new Map();
    this.items = new Map();
    this.itemUnits = new Map();
    this.prices = new Map();
    this.customers = new Map();
    this.suppliers = new Map();
    this.warehouses = new Map();
    this.stockBalances = new Map();
    this.commerceDocuments = new Map();
    this.journalEntries = new Map();
    this.serverOutbox = [];
    this.itemBarcodes = new Map();
    this.posDevices = new Map();
    this.posShifts = new Map();
    this.offlineAllocations = new Map();
    this.posReceipts = new Map();
    this.posDiscountPolicies = new Map();
    this.representatives = new Map();
    this.representativeCustomers = new Map();
    this.representativeRoutes = new Map();
    this.stockTransfers = new Map();
    this.representativeOrders = new Map();
    this.debtMovements = new Map();
    this.representativeCollections = new Map();
    this.custodyMovements = new Map();
    this.representativeHandovers = new Map();
    this.syncConflicts = new Map();
    this.departments = new Map(); this.employees = new Map(); this.employeeContracts = new Map();
    this.employeeComponents = new Map(); this.employeeAdvances = new Map(); this.workShifts = new Map();
    this.employeeShiftAssignments = new Map(); this.attendanceEvents = new Map(); this.overtimeRequests = new Map();
    this.leaveRequests = new Map(); this.payrollSettings = new Map(); this.payrollCycles = new Map();
    this.payrollPayments = new Map(); this.payrollAdjustments = new Map();
    this.salesSettings = new Map(); this.salesApprovals = new Map(); this.salesReviews = new Map();
    this.changeSequence = 0;
  }

  async close() {}
  async saveSalesSetting(key,value,actor) { this.salesSettings.set(key,clone(value));this.#audit(value.companyId,actor,'sales.setting.updated','sales_setting',key,{});return clone(value); }
  async saveSalesApproval(row) { this.salesApprovals.set(row.id,clone(row));this.#audit(row.companyId,row.reviewedBy||row.userId,'sales.approval.'+row.status,'sales_approval',row.id,{});return clone(row); }
  async saveSalesReview(row) { this.salesReviews.set(row.id,clone(row));return clone(row); }


  async seedPlatformAdmin({ username, passwordHash, displayName = 'Platform Admin' }) {
    const existing = [...this.users.values()].find((user) => user.platformAdmin && user.username === username);
    if (existing) return clone(existing);
    const user = {
      id: randomUUID(), companyId: null, username, displayName, passwordHash,
      platformAdmin: true, status: 'active', roleIds: [], scopes: [], createdAt: new Date().toISOString()
    };
    this.users.set(user.id, user);
    return clone(user);
  }

  async listPlatformAdmins() {
    return [...this.users.values()].filter((user) => user.platformAdmin).map((user) => this.#publicUser(user));
  }

  async createPlatformAdmin({ username, displayName, passwordHash }, actorUserId) {
    if ([...this.users.values()].some((user) => user.platformAdmin && user.username === username)) {
      throw new AppError(409, 'USERNAME_EXISTS', 'اسم مستخدم المطور مستخدم');
    }
    const user = { id: randomUUID(), companyId: null, username, displayName, passwordHash, platformAdmin: true,
      status: 'active', roleIds: [], scopes: [], createdAt: new Date().toISOString(), createdBy: actorUserId };
    this.users.set(user.id, user);
    this.#audit(null, actorUserId, 'platform_admin.created', 'user', user.id, {});
    return this.#publicUser(user);
  }

  async listPlatformCompanies() {
    return [...this.companies.values()].map((company) => this.#publicCompany(company));
  }

  async setCompanyStatus(companyId, status, actorUserId) {
    if (!['active','suspended'].includes(status)) throw new AppError(400, 'INVALID_STATUS', 'حالة الشركة غير صالحة');
    const company=this.companies.get(companyId);
    if(!company) throw new AppError(404,'COMPANY_NOT_FOUND','الشركة غير موجودة');
    company.status=status;
    for(const user of this.users.values()) if(user.companyId===companyId) user.status=status==='active'?'active':'suspended';
    this.#audit(null,actorUserId,'company.status_changed','company',companyId,{status});
    return this.#publicCompany(company);
  }

  async registerCompany({ code, legalName, timezone, currency, phone, address, owner }) {
    if ([...this.companies.values()].some((company) => company.code === code)) {
      throw new AppError(409, 'COMPANY_CODE_EXISTS', 'رمز الشركة مستخدم');
    }
    const companyId = randomUUID();
    const now = new Date().toISOString();
    const branchId = randomUUID();
    const company = {
      id: companyId, code, legalName, timezone, currency, phone, address, status: 'pending',
      createdAt: now, approvedAt: null, ownerUserId: null,
      branches: [{ id: branchId, name: 'الفرع الرئيسي', code: 'main', active: true }]
    };
    for (const [roleCode, permissions] of Object.entries(ROLE_TEMPLATES)) {
      const role = { id: randomUUID(), companyId, code: roleCode, name: roleCode, permissions: [...permissions], system: true };
      this.roles.set(role.id, role);
    }
    const adminRole = [...this.roles.values()].find((role) => role.companyId === companyId && role.code === 'company_admin');
    const user = {
      id: randomUUID(), companyId, username: owner.username, displayName: owner.displayName,
      passwordHash: owner.passwordHash, platformAdmin: false, status: 'pending',
      roleIds: [adminRole.id], scopes: [{ type: 'company', id: companyId }], createdAt: now
    };
    company.ownerUserId = user.id;
    this.companies.set(company.id, company);
    this.users.set(user.id, user);
    this.#audit(null, null, 'company.registered', 'company', company.id, { code });
    return this.#publicCompany(company);
  }

  async listPendingCompanies() {
    return [...this.companies.values()].filter((company) => company.status === 'pending').map((company) => this.#publicCompany(company));
  }

  async approveCompany(companyId, actorUserId, approvedCode = null) {
    const company = this.companies.get(companyId);
    if (!company) throw new AppError(404, 'COMPANY_NOT_FOUND', 'الشركة غير موجودة');
    if (company.status === 'active') return this.#publicCompany(company);
    if (approvedCode) {
      const code=String(approvedCode).trim().toLowerCase();
      if ([...this.companies.values()].some((x)=>x.id!==companyId && x.code===code)) throw new AppError(409,'COMPANY_CODE_EXISTS','رمز الشركة مستخدم');
      company.code=code;
    }
    company.status = 'active';
    company.approvedAt = new Date().toISOString();
    for (const user of this.users.values()) {
      if (user.companyId === companyId && user.status === 'pending') user.status = 'active';
    }
    this.#audit(null, actorUserId, 'company.approved', 'company', companyId, {});
    this.#change(companyId, 'company', companyId, 'upsert', this.#publicCompany(company));
    return this.#publicCompany(company);
  }

  async updatePlatformCompany(companyId, input, actorUserId) {
    const company=this.companies.get(companyId);
    if(!company) throw new AppError(404,'COMPANY_NOT_FOUND','الشركة غير موجودة');
    if(input.legalName) company.legalName=String(input.legalName).trim();
    if(input.phone!==undefined) company.phone=String(input.phone).trim().slice(0,32);
    if(input.address!==undefined) company.address=String(input.address).trim().slice(0,240);
    if(input.code) {
      const code=String(input.code).trim().toUpperCase();
      if([...this.companies.values()].some(x=>x.id!==companyId&&x.code===code)) throw new AppError(409,'COMPANY_CODE_EXISTS','رمز الشركة مستخدم');
      company.code=code;
    }
    this.#audit(null,actorUserId,'company.updated','company',companyId,{});
    return this.#publicCompany(company);
  }

  async deletePlatformCompany(companyId, actorUserId) {
    const company=this.companies.get(companyId);
    if(!company) throw new AppError(404,'COMPANY_NOT_FOUND','الشركة غير موجودة');
    for(const [id,user] of this.users) if(user.companyId===companyId) this.users.delete(id);
    for(const [id,role] of this.roles) if(role.companyId===companyId) this.roles.delete(id);
    this.companies.delete(companyId);
    this.#audit(null,actorUserId,'company.deleted','company',companyId,{});
    return {id:companyId};
  }

  async findLogin({ companyCode, username, platform }) {
    if (platform) {
      const user = [...this.users.values()].find((candidate) => candidate.platformAdmin && candidate.username === username);
      return user ? { user: clone(user), company: null } : null;
    }
    const company = [...this.companies.values()].find((candidate) => String(candidate.code).toLowerCase() === companyCode);
    if (!company) return null;
    const user = [...this.users.values()].find((candidate) => candidate.companyId === company.id && candidate.username === username);
    return user ? { user: clone(user), company: this.#publicCompany(company) } : null;
  }

  async createSession({ tokenHash, userId, deviceId, expiresAt }) {
    const session = { id: randomUUID(), tokenHash, userId, deviceId, expiresAt, revokedAt: null, createdAt: new Date().toISOString() };
    this.sessions.set(tokenHash, session);
    const user = this.users.get(userId);
    this.#audit(user.companyId, userId, 'session.created', 'session', session.id, { deviceId });
    return clone(session);
  }

  async getSessionContext(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
    const user = this.users.get(session.userId);
    if (!user || user.status !== 'active') return null;
    const company = user.companyId ? this.companies.get(user.companyId) : null;
    if (company && company.status !== 'active') return null;
    const roles = user.roleIds.map((id) => this.roles.get(id)).filter(Boolean);
    const permissions = user.platformAdmin ? ['company.approve'] : (user.permissions ?? [...new Set(roles.flatMap((role) => role.permissions))]);
    return {
      session: clone(session), user: this.#publicUser(user), company: company ? this.#publicCompany(company) : null,
      roles: roles.map(({ passwordHash, ...role }) => clone(role)), permissions, scopes: clone(user.scopes)
    };
  }

  async revokeSession(tokenHash, actorUserId) {
    const session = this.sessions.get(tokenHash);
    if (session) session.revokedAt = new Date().toISOString();
    const user = this.users.get(actorUserId);
    this.#audit(user?.companyId ?? null, actorUserId, 'session.revoked', 'session', session?.id ?? null, {});
  }

  async listLoginRoles(companyCode) {
    const company = [...this.companies.values()].find(row => row.code.toLowerCase() === companyCode && row.status === 'active');
    if (!company) return [];
    return (await this.listRoles(company.id)).map(({ code, name }) => ({ code, name }));
  }

  async listRoles(companyId) {
    return [...this.roles.values()].filter((role) => role.companyId === companyId).map(clone);
  }

  async createRole(companyId, input, actorUserId) {
    if ([...this.roles.values()].some(role => role.companyId === companyId && role.name === input.name)) throw new AppError(409, 'ROLE_NAME_EXISTS', 'اسم الدور موجود في الشركة');
    const id = randomUUID();
    const role = { id, companyId, code: 'custom_' + id, name: input.name, system: false, permissions: [...new Set(input.permissions)] };
    this.roles.set(id, role);
    this.#audit(companyId, actorUserId, 'role.created', 'role', id, { name: role.name, permissions: role.permissions });
    this.#change(companyId, 'role', id, 'upsert', role);
    return clone(role);
  }

  async createUser(companyId, input, actorUserId) {
    if ([...this.users.values()].some((user) => user.companyId === companyId && user.username === input.username)) {
      throw new AppError(409, 'USERNAME_EXISTS', 'اسم المستخدم مستخدم في الشركة');
    }
    const role = [...this.roles.values()].find((candidate) => candidate.companyId === companyId && candidate.code === input.roleCode);
    if (!role) throw new AppError(400, 'ROLE_NOT_FOUND', 'الدور غير موجود');
    if (input.permissions != null && (!Array.isArray(input.permissions) || input.permissions.some(value => !PERMISSIONS.includes(value) || value === 'company.approve'))) throw new AppError(400, 'INVALID_PERMISSIONS', 'الصلاحيات غير صالحة');
    const user = {
      id: randomUUID(), companyId, username: input.username, displayName: input.displayName,
      passwordHash: input.passwordHash, platformAdmin: false, status: 'active', roleIds: [role.id], ...(input.permissions != null ? {permissions: [...input.permissions]} : {}),
      scopes: input.scopes?.length ? clone(input.scopes) : [{ type: 'company', id: companyId }],
      createdAt: new Date().toISOString()
    };
    this.users.set(user.id, user);
    this.#audit(companyId, actorUserId, 'user.created', 'user', user.id, { roleCode: input.roleCode });
    this.#change(companyId, 'user', user.id, 'upsert', this.#publicUser(user));
    return this.#publicUser(user);
  }

  async listUsers(companyId) {
    return [...this.users.values()].filter(user => user.companyId === companyId).map(user => ({
      ...this.#publicUser(user), roleCode: this.roles.get(user.roleIds[0])?.code,
      permissions: user.permissions ?? [...new Set(user.roleIds.flatMap(id => this.roles.get(id)?.permissions || []))]
    }));
  }

  async updateUser(companyId, userId, input, actorUserId) {
    const user = this.users.get(userId);
    if (!user || user.companyId !== companyId || user.platformAdmin) throw new AppError(404, 'USER_NOT_FOUND', 'المستخدم غير موجود');
    const role = [...this.roles.values()].find(row => row.companyId === companyId && row.code === input.roleCode);
    if (!role) throw new AppError(400, 'ROLE_NOT_FOUND', 'الدور غير موجود');
    if ([...this.users.values()].some(row => row.companyId === companyId && row.id !== userId && row.username === input.username)) throw new AppError(409, 'USERNAME_EXISTS', 'اسم المستخدم مستخدم في الشركة');
    if (!['active', 'disabled'].includes(input.status)) throw new AppError(400, 'INVALID_STATUS', 'حالة الحساب غير صالحة');
    const permissions = input.permissions ?? role.permissions;
    if (!Array.isArray(permissions) || permissions.some(value => !PERMISSIONS.includes(value) || value === 'company.approve')) throw new AppError(400, 'INVALID_PERMISSIONS', 'الصلاحيات غير صالحة');
    if (userId === actorUserId && (input.status !== 'active' || !permissions.includes('users.manage'))) throw new AppError(409, 'SELF_LOCKOUT', 'لا يمكنك إيقاف حسابك أو إزالة صلاحية إدارة المستخدمين منه');
    const managers = await this.listUsers(companyId);
    if (user.status === 'active' && managers.find(row => row.id === userId)?.permissions.includes('users.manage') && (input.status !== 'active' || !permissions.includes('users.manage')) && !managers.some(row => row.id !== userId && row.status === 'active' && row.permissions.includes('users.manage'))) throw new AppError(409, 'LAST_MANAGER', 'يجب إبقاء مسؤول نشط لإدارة المستخدمين');
    Object.assign(user, { username: input.username, displayName: input.displayName, status: input.status, roleIds: [role.id], permissions: [...permissions], updatedAt: new Date().toISOString() });
    if (input.passwordHash) user.passwordHash = input.passwordHash;
    if (input.passwordHash || input.status === 'disabled') for (const session of this.sessions.values()) if (session.userId === userId) session.revokedAt = new Date().toISOString();
    this.#audit(companyId, actorUserId, 'user.updated', 'user', userId, { roleCode: input.roleCode, status: input.status, permissions, passwordChanged: Boolean(input.passwordHash) });
    this.#change(companyId, 'user', userId, 'upsert', this.#publicUser(user));
    return (await this.listUsers(companyId)).find(row => row.id === userId);
  }

  async createUnit(companyId, input, actorUserId) {
    this.#assertUnique(this.units, companyId, 'code', input.code, 'UNIT_CODE_EXISTS');
    const unit = { id: randomUUID(), companyId, code: input.code, name: input.name, decimalPlaces: input.decimalPlaces ?? 3 };
    this.units.set(unit.id, unit);
    this.#audit(companyId, actorUserId, 'unit.created', 'unit', unit.id, {});
    this.#change(companyId, 'unit', unit.id, 'upsert', unit);
    return clone(unit);
  }

  async createItem(companyId, input, actorUserId) {
    this.#assertUnique(this.items, companyId, 'sku', input.sku, 'ITEM_SKU_EXISTS');
    const unit = this.units.get(input.baseUnitId);
    if (!unit || unit.companyId !== companyId) throw new AppError(400, 'UNIT_NOT_FOUND', 'الوحدة غير موجودة');
    const item = { id: randomUUID(), companyId, sku: input.sku, name: input.name, baseUnitId: unit.id, active: true };
    this.items.set(item.id, item);
    const itemUnit = { id: randomUUID(), companyId, itemId: item.id, unitId: unit.id, conversionFactor: '1.000000', isBase: true };
    this.itemUnits.set(itemUnit.id, itemUnit);
    this.#audit(companyId, actorUserId, 'item.created', 'item', item.id, {});
    this.#change(companyId, 'item', item.id, 'upsert', { ...item, units: [itemUnit] });
    return clone({ ...item, units: [itemUnit] });
  }

  async addItemUnit(companyId, itemId, input, actorUserId) {
    const item = this.items.get(itemId);
    const unit = this.units.get(input.unitId);
    if (!item || item.companyId !== companyId || !unit || unit.companyId !== companyId) throw new AppError(404, 'ITEM_OR_UNIT_NOT_FOUND', 'المادة أو الوحدة غير موجودة');
    if ([...this.itemUnits.values()].some((row) => row.companyId === companyId && row.itemId === itemId && row.unitId === input.unitId)) {
      throw new AppError(409, 'ITEM_UNIT_EXISTS', 'الوحدة مضافة للمادة');
    }
    decimal(input.conversionFactor, { positive: true });
    const row = { id: randomUUID(), companyId, itemId, unitId: input.unitId, conversionFactor: decimalString(decimal(input.conversionFactor)), isBase: false };
    this.itemUnits.set(row.id, row);
    this.#audit(companyId, actorUserId, 'item_unit.created', 'item_unit', row.id, {});
    this.#change(companyId, 'item_unit', row.id, 'upsert', row);
    return clone(row);
  }

  async setPrice(companyId, input, actorUserId) {
    const relation = [...this.itemUnits.values()].find((row) => row.companyId === companyId && row.itemId === input.itemId && row.unitId === input.unitId);
    if (!relation) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
    decimal(input.amount, { nonNegative: true });
    const price = { id: randomUUID(), companyId, ...input, amount: decimalString(decimal(input.amount)), active: true, validFrom: new Date().toISOString() };
    this.prices.set(price.id, price);
    this.#audit(companyId, actorUserId, 'price.created', 'price', price.id, {});
    this.#change(companyId, 'price', price.id, 'upsert', price);
    return clone(price);
  }

  async createParty(companyId, type, input, actorUserId) {
    const map = type === 'customer' ? this.customers : this.suppliers;
    this.#assertUnique(map, companyId, 'code', input.code, `${type.toUpperCase()}_CODE_EXISTS`);
    const party = { id: randomUUID(), companyId, code: input.code, name: input.name, phone: input.phone || null, active: true };
    if (type === 'customer') party.creditLimit = decimalString(decimal(input.creditLimit || '0', { nonNegative: true }));
    map.set(party.id, party);
    this.#audit(companyId, actorUserId, `${type}.created`, type, party.id, {});
    this.#change(companyId, type, party.id, 'upsert', party);
    return clone(party);
  }

  async createWarehouse(companyId, input, actorUserId) {
    this.#assertUnique(this.warehouses, companyId, 'code', input.code, 'WAREHOUSE_CODE_EXISTS');
    const warehouse = { id: randomUUID(), companyId, code: input.code, name: input.name, kind: input.kind || 'standard', branchId: input.branchId || null, active: true };
    this.warehouses.set(warehouse.id, warehouse);
    this.#audit(companyId, actorUserId, 'warehouse.created', 'warehouse', warehouse.id, {});
    this.#change(companyId, 'warehouse', warehouse.id, 'upsert', warehouse);
    return clone(warehouse);
  }

  async listMasterData(companyId) {
    const belongs = (row) => row.companyId === companyId;
    return {
      units: [...this.units.values()].filter(belongs).map(clone),
      items: [...this.items.values()].filter(belongs).map((item) => ({ ...clone(item), units: [...this.itemUnits.values()].filter((row) => row.companyId === companyId && row.itemId === item.id).map(clone) })),
      prices: [...this.prices.values()].filter(belongs).map(clone),
      customers: [...this.customers.values()].filter(belongs).map(clone),
      suppliers: [...this.suppliers.values()].filter(belongs).map(clone),
      warehouses: [...this.warehouses.values()].filter(belongs).map(clone),
      stock: [...this.stockBalances.values()].filter(belongs).map(clone)
    };
  }

  async listEnterpriseData(companyId) {
    const belongs = row => row.companyId === companyId;
    return { representatives: [...this.representatives.values()].filter(belongs).map(clone), journals: [...this.journalEntries.values()].filter(belongs).map(clone),
      transfers: [...this.stockTransfers.values()].filter(belongs).map(clone),
      settlements: [...this.financialRecords.values()].filter(row => belongs(row) && row.kind === 'enterprise_settlement').map(clone),
      users: [...this.users.values()].filter(belongs).map(row => this.#publicUser(row)) };
  }

  async transferEnterpriseStock(context, input) {
    const existing = [...this.stockTransfers.values()].find(row => row.companyId === context.company.id && row.operationId === input.operationId);
    if (existing) { if (existing.transferNumber !== input.transferNumber || existing.sourceWarehouseId !== input.sourceWarehouseId || existing.destinationWarehouseId !== input.destinationWarehouseId) throw new AppError(409,'OPERATION_ID_REUSED','معرف العملية مستخدم لبيانات أخرى'); return clone(existing); }
    this.#assertUnique(this.stockTransfers,context.company.id,'transferNumber',input.transferNumber,'TRANSFER_NUMBER_EXISTS');
    for (const id of [input.sourceWarehouseId, input.destinationWarehouseId]) {
      const warehouse = this.warehouses.get(id);
      if (!warehouse || warehouse.companyId !== context.company.id) throw new AppError(400, 'WAREHOUSE_NOT_FOUND', 'المخزن غير موجود');
    }
    for (const line of input.lines) {
      const item = this.items.get(line.itemId);
      if (!item || item.companyId !== context.company.id) throw new AppError(400, 'ITEM_NOT_FOUND', 'الصنف غير موجود');
    }
    const before = this.#representativeTransactionSnapshot();
    try { return this.#transferRepresentativeStock(context, { operationId: input.operationId, occurredAt: input.occurredAt }, input.sourceWarehouseId, input.destinationWarehouseId, input.lines, input.transferNumber, null); }
    catch (error) { this.#restoreRepresentativeTransaction(before); throw error; }
  }

  async settleEnterpriseDocument(context, input) {
    const existing = [...this.financialRecords.values()].find(row => row.companyId === context.company.id && row.kind === 'enterprise_settlement' && row.operationId === input.operationId);
    if (existing) { if (existing.documentId !== input.documentId || existing.amount !== decimalString(decimal(input.amount)) || existing.method !== input.method) throw new AppError(409,'OPERATION_ID_REUSED','معرف العملية مستخدم لبيانات أخرى'); return clone(existing); }
    this.#assertUnique(this.financialRecords,context.company.id,'receiptNumber',input.receiptNumber,'RECEIPT_NUMBER_EXISTS');
    const document = this.commerceDocuments.get(input.documentId);
    if (!document || document.companyId !== context.company.id || !['sale', 'purchase'].includes(document.documentType)) throw new AppError(400, 'DOCUMENT_NOT_FOUND', 'مستند البيع أو الشراء غير موجود');
    const settled = [...this.financialRecords.values()].filter(row => row.companyId === context.company.id && row.kind === 'enterprise_settlement' && row.documentId === document.id).reduce((sum,row) => sum + decimal(row.amount), ZERO);
    const returned = [...this.commerceDocuments.values()].filter(row => row.companyId === context.company.id && row.originalDocumentId === document.id).reduce((sum,row) => sum + decimal(row.dueAmount), ZERO);
    const amount = decimal(input.amount, { positive: true });
    if (amount > decimal(document.dueAmount) - settled - returned) throw new AppError(409, 'SETTLEMENT_EXCEEDS_DUE', 'المبلغ يتجاوز الرصيد المتبقي');
    const cash = input.method === 'bank' ? '1010-BANK' : '1000-CASH';
    const lines = document.documentType === 'sale' ? [[cash,amount,ZERO],['1100-AR',ZERO,amount]] : [['2100-AP',amount,ZERO],[cash,ZERO,amount]];
    const journal = this.#simpleJournal(context, input, input.receiptNumber, document.currency, lines);
    const row = { id: randomUUID(), companyId: context.company.id, kind: 'enterprise_settlement', operationId: input.operationId, documentId: document.id, receiptNumber: input.receiptNumber, amount: decimalString(amount), method: input.method, journalEntryId: journal.id, occurredAt: input.occurredAt, createdBy: context.user.id };
    this.financialRecords.set(row.id, Object.freeze(row));
    this.#audit(context.company.id,context.user.id,'enterprise.settlement','financial_record',row.id,{});
    this.#change(context.company.id,'financial_record',row.id,'upsert',row);
    return clone(row);
  }

  async listCommerceDocuments(companyId) {
    return [...this.commerceDocuments.values()].filter((document) => document.companyId === companyId).map(clone);
  }

  async createDepartment(companyId,input,actorUserId){this.#assertUnique(this.departments,companyId,'code',input.code,'DEPARTMENT_CODE_EXISTS');const row={id:randomUUID(),companyId,code:input.code,name:input.name,active:true};this.departments.set(row.id,row);this.#audit(companyId,actorUserId,'department.created','department',row.id,{});this.#change(companyId,'department',row.id,'upsert',row);return clone(row);}
  async createEmployee(companyId,input,actorUserId){this.#assertUnique(this.employees,companyId,'code',input.code,'EMPLOYEE_CODE_EXISTS');if(input.departmentId&&(!this.departments.get(input.departmentId)||this.departments.get(input.departmentId).companyId!==companyId))throw new AppError(400,'DEPARTMENT_NOT_FOUND','القسم غير موجود');if(input.userId&&(!this.users.get(input.userId)||this.users.get(input.userId).companyId!==companyId))throw new AppError(400,'USER_NOT_FOUND','المستخدم غير موجود');const row={id:randomUUID(),companyId,userId:input.userId||null,departmentId:input.departmentId||null,code:input.code,fullName:input.fullName,jobTitle:input.jobTitle,hireDate:input.hireDate,status:'active'};this.employees.set(row.id,row);this.#audit(companyId,actorUserId,'employee.created','employee',row.id,{});this.#change(companyId,'employee',row.id,'upsert',row);return clone(row);}
  async createEmployeeContract(companyId,employeeId,input,actorUserId){const employee=this.employees.get(employeeId);if(!employee||employee.companyId!==companyId)throw new AppError(404,'EMPLOYEE_NOT_FOUND','الموظف غير موجود');if([...this.employeeContracts.values()].some(x=>x.companyId===companyId&&x.employeeId===employeeId&&x.status==='active'))throw new AppError(409,'ACTIVE_CONTRACT_EXISTS','يوجد عقد فعال للموظف');const row={id:randomUUID(),companyId,employeeId,contractNumber:input.contractNumber,startDate:input.startDate,endDate:input.endDate||null,basicSalary:decimalString(decimal(input.basicSalary,{nonNegative:true})),currency:input.currency,payFrequency:'monthly',status:'active'};this.employeeContracts.set(row.id,row);this.#audit(companyId,actorUserId,'employee.contract.created','employee_contract',row.id,{});this.#change(companyId,'employee_contract',row.id,'upsert',row);return clone(row);}
  async addEmployeeComponent(companyId,employeeId,input,actorUserId){const employee=this.employees.get(employeeId);if(!employee||employee.companyId!==companyId)throw new AppError(404,'EMPLOYEE_NOT_FOUND','الموظف غير موجود');const row={id:randomUUID(),companyId,employeeId,code:input.code,name:input.name,componentType:input.componentType,amount:decimalString(decimal(input.amount,{nonNegative:true})),active:true};this.employeeComponents.set(row.id,row);this.#audit(companyId,actorUserId,'employee.component.created','employee_component',row.id,{});return clone(row);}
  async createEmployeeAdvance(companyId,employeeId,input,actorUserId){const employee=this.employees.get(employeeId);if(!employee||employee.companyId!==companyId)throw new AppError(404,'EMPLOYEE_NOT_FOUND','الموظف غير موجود');const amount=decimal(input.originalAmount,{positive:true}),installment=decimal(input.installmentAmount,{positive:true});const row={id:randomUUID(),companyId,employeeId,advanceNumber:input.advanceNumber,originalAmount:decimalString(amount),remainingAmount:decimalString(amount),installmentAmount:decimalString(installment),currency:input.currency,status:'active',grantedAt:input.grantedAt};this.employeeAdvances.set(row.id,row);this.#audit(companyId,actorUserId,'employee.advance.created','employee_advance',row.id,{});return clone(row);}
  async createWorkShift(companyId,input,actorUserId){this.#assertUnique(this.workShifts,companyId,'code',input.code,'SHIFT_CODE_EXISTS');const row={id:randomUUID(),companyId,...input,active:true};this.workShifts.set(row.id,row);this.#audit(companyId,actorUserId,'work_shift.created','work_shift',row.id,{});return clone(row);}
  async assignEmployeeShift(companyId,employeeId,input,actorUserId){const employee=this.employees.get(employeeId),shift=this.workShifts.get(input.shiftId);if(!employee||employee.companyId!==companyId||!shift||shift.companyId!==companyId)throw new AppError(404,'EMPLOYEE_OR_SHIFT_NOT_FOUND','الموظف أو الشفت غير موجود');const row={id:randomUUID(),companyId,employeeId,shiftId:input.shiftId,effectiveFrom:input.effectiveFrom,effectiveTo:input.effectiveTo||null};this.employeeShiftAssignments.set(row.id,row);this.#audit(companyId,actorUserId,'employee.shift.assigned','employee_shift_assignment',row.id,{});return clone(row);}
  async createOvertimeRequest(companyId,input,actorUserId){this.#employee(companyId,input.employeeId);const row={id:randomUUID(),companyId,employeeId:input.employeeId,workDate:input.workDate,minutes:input.minutes,multiplier:decimalString(decimal(input.multiplier,{positive:true})),reason:input.reason||null,status:'pending',requestedBy:actorUserId};this.overtimeRequests.set(row.id,row);return clone(row);}
  async decideOvertime(companyId,id,approved,actorUserId){const row=this.overtimeRequests.get(id);if(!row||row.companyId!==companyId||row.status!=='pending')throw new AppError(409,'OVERTIME_NOT_PENDING','الإضافي غير متاح للاعتماد');row.status=approved?'approved':'rejected';row.approvedBy=actorUserId;row.approvedAt=new Date().toISOString();this.#audit(companyId,actorUserId,'overtime.decided','overtime_request',id,{approved});return clone(row);}
  async createLeaveRequest(companyId,input,actorUserId){const employee=this.#employee(companyId,input.employeeId);if(employee.userId&&employee.userId!==actorUserId&&!input.managerEntry)throw new AppError(403,'EMPLOYEE_SCOPE_DENIED','لا يمكن تقديم إجازة لموظف آخر');const row={id:randomUUID(),companyId,employeeId:input.employeeId,leaveType:input.leaveType,startDate:input.startDate,endDate:input.endDate,paid:input.paid,reason:input.reason||null,status:'pending',requestedBy:actorUserId};this.leaveRequests.set(row.id,row);return clone(row);}
  async decideLeave(companyId,id,approved,actorUserId){const row=this.leaveRequests.get(id);if(!row||row.companyId!==companyId||row.status!=='pending')throw new AppError(409,'LEAVE_NOT_PENDING','الإجازة غير متاحة للاعتماد');row.status=approved?'approved':'rejected';row.approvedBy=actorUserId;row.approvedAt=new Date().toISOString();this.#audit(companyId,actorUserId,'leave.decided','leave_request',id,{approved});return clone(row);}
  async setPayrollSettings(companyId,input,actorUserId){const row={companyId,workingDaysPerMonth:input.workingDaysPerMonth,dailyHours:decimalString(decimal(input.dailyHours,{positive:true})),defaultOvertimeMultiplier:decimalString(decimal(input.defaultOvertimeMultiplier,{positive:true})),deductAbsence:input.deductAbsence,attendanceRequired:input.attendanceRequired,updatedBy:actorUserId,updatedAt:new Date().toISOString()};this.payrollSettings.set(companyId,row);this.#audit(companyId,actorUserId,'payroll.settings.updated','payroll_settings',companyId,{});return clone(row);}
  async getHrBootstrap(context){const c=context.company.id,own=this.#employeeByUser(c,context.user.id);const canManage=context.permissions.includes('employees.manage')||context.permissions.includes('payroll.read');const filter=x=>x.companyId===c&&(canManage||x.id===own?.id||x.employeeId===own?.id);return{departments:[...this.departments.values()].filter(x=>x.companyId===c).map(clone),employees:[...this.employees.values()].filter(filter).map(clone),contracts:[...this.employeeContracts.values()].filter(filter).map(clone),components:[...this.employeeComponents.values()].filter(filter).map(clone),advances:[...this.employeeAdvances.values()].filter(filter).map(clone),shifts:[...this.workShifts.values()].filter(x=>x.companyId===c).map(clone),assignments:[...this.employeeShiftAssignments.values()].filter(filter).map(clone),attendance:[...this.attendanceEvents.values()].filter(filter).map(clone),overtime:[...this.overtimeRequests.values()].filter(filter).map(clone),leaves:[...this.leaveRequests.values()].filter(filter).map(clone),payrollCycles:canManage?[...this.payrollCycles.values()].filter(x=>x.companyId===c).map(clone):[],settings:clone(this.payrollSettings.get(c)||this.#defaultPayrollSettings(c)),ownEmployee:own?clone(own):null};}
  async createPayrollCycle(context,input){const c=context.company.id;if([...this.payrollCycles.values()].some(x=>x.companyId===c&&x.cycleCode===input.cycleCode))throw new AppError(409,'PAYROLL_CYCLE_EXISTS','دورة الرواتب موجودة');const settings=this.payrollSettings.get(c)||this.#defaultPayrollSettings(c);const lines=[];for(const employee of this.employees.values()){if(employee.companyId!==c||employee.status!=='active')continue;const contract=[...this.employeeContracts.values()].find(x=>x.companyId===c&&x.employeeId===employee.id&&x.status==='active'&&x.startDate<=input.periodEnd&&(!x.endDate||x.endDate>=input.periodStart));if(!contract||contract.currency!==input.currency)continue;lines.push(this.#calculatePayrollLine(c,employee,contract,settings,input));}const totalGross=lines.reduce((s,x)=>s+decimal(x.grossAmount),ZERO),totalDeductions=lines.reduce((s,x)=>s+decimal(x.totalDeductions),ZERO),totalNet=lines.reduce((s,x)=>s+decimal(x.netAmount),ZERO);const row={id:input.id,companyId:c,cycleCode:input.cycleCode,periodStart:input.periodStart,periodEnd:input.periodEnd,currency:input.currency,status:'draft',totalGross:decimalString(totalGross),totalDeductions:decimalString(totalDeductions),totalNet:decimalString(totalNet),calculationSnapshot:clone(settings),createdBy:context.user.id,lines};this.payrollCycles.set(row.id,row);this.#audit(c,context.user.id,'payroll.cycle.drafted','payroll_cycle',row.id,{});this.#change(c,'payroll_cycle',row.id,'upsert',row);return clone(row);}
  async reviewPayrollCycle(context,id){const row=this.#payrollCycle(context.company.id,id);if(row.status!=='draft')throw new AppError(409,'PAYROLL_NOT_DRAFT','الدورة ليست مسودة');row.status='reviewed';row.reviewedBy=context.user.id;row.reviewedAt=new Date().toISOString();this.#audit(context.company.id,context.user.id,'payroll.cycle.reviewed','payroll_cycle',id,{});return clone(row);}
  async approvePayrollCycle(context,id,operationId){const row=this.#payrollCycle(context.company.id,id);if(row.status==='approved'&&row.approveOperationId===operationId)return clone(row);if(row.status!=='reviewed')throw new AppError(409,'PAYROLL_NOT_REVIEWED','يجب مراجعة الدورة أولًا');if([...this.payrollCycles.values()].some(x=>x.companyId===context.company.id&&x.approveOperationId===operationId))throw new AppError(409,'OPERATION_ID_REUSED','معرف العملية مستخدم');const journal=this.#payrollAccrualJournal(context,row,operationId);row.status='approved';row.approvedBy=context.user.id;row.approvedAt=new Date().toISOString();row.approveOperationId=operationId;row.accrualJournalId=journal.id;this.#audit(context.company.id,context.user.id,'payroll.cycle.approved','payroll_cycle',id,{});return clone(row);}
  async payPayrollCycle(context,id,input){const row=this.#payrollCycle(context.company.id,id);if(row.status==='paid'&&row.payOperationId===input.operationId)return clone(row);if(row.status!=='approved')throw new AppError(409,'PAYROLL_NOT_APPROVED','الدورة غير معتمدة للصرف');if([...this.payrollPayments.values()].some(x=>x.companyId===context.company.id&&(x.cycleId===id||x.operationId===input.operationId)))throw new AppError(409,'PAYROLL_ALREADY_PAID','الدورة مصروفة أو معرف العملية مستخدم');const journal=this.#simpleJournal(context,{operationId:input.operationId,occurredAt:input.paidAt},`PAY-${row.cycleCode}`,row.currency,[['2300-PAYROLL-PAYABLE',decimal(row.totalNet),ZERO],['1000-CASH',ZERO,decimal(row.totalNet)]]);const payment={id:randomUUID(),companyId:context.company.id,cycleId:id,paymentNumber:input.paymentNumber,amount:row.totalNet,currency:row.currency,operationId:input.operationId,paidAt:input.paidAt,paidBy:context.user.id};this.payrollPayments.set(payment.id,Object.freeze(payment));row.status='paid';row.payOperationId=input.operationId;row.paymentJournalId=journal?.id;row.paidAt=input.paidAt;row.paidBy=context.user.id;this.#audit(context.company.id,context.user.id,'payroll.cycle.paid','payroll_cycle',id,{});return clone(row);}
  async adjustPayrollCycle(context,id,input){const cycle=this.#payrollCycle(context.company.id,id);if(!['approved','paid'].includes(cycle.status))throw new AppError(409,'PAYROLL_NOT_LOCKED','التسوية بعد اعتماد الدورة فقط');this.#employee(context.company.id,input.employeeId);const existing=[...this.payrollAdjustments.values()].find(x=>x.companyId===context.company.id&&x.operationId===input.operationId);if(existing)return clone(existing);const amount=decimal(input.amount,{positive:true});const lines=input.adjustmentType==='earning'?[['6100-PAYROLL-EXPENSE',amount,ZERO],['2300-PAYROLL-PAYABLE',ZERO,amount]]:[['1400-EMPLOYEE-RECEIVABLE',amount,ZERO],['6150-PAYROLL-RECOVERY',ZERO,amount]];const journal=this.#simpleJournal(context,{operationId:input.operationId,occurredAt:input.occurredAt},`ADJ-${input.adjustmentNumber}`,input.currency,lines);const row={id:randomUUID(),companyId:context.company.id,cycleId:id,employeeId:input.employeeId,adjustmentNumber:input.adjustmentNumber,adjustmentType:…16514 tokens truncated…aid); add('2100-AP', ZERO, due);
    } else if (document.documentType === 'sale') {
      add(cashAccount, paid, ZERO); add('1100-AR', due, ZERO); add('4100-SALES', ZERO, total);
      add('5100-COGS', inventoryCost, ZERO); add('1200-INVENTORY', ZERO, inventoryCost);
    } else if (document.documentType === 'purchase_return') {
      add('1000-CASH', paid, ZERO); add('2100-AP', due, ZERO); add('1200-INVENTORY', ZERO, total);
    } else {
      add('4200-SALES-RETURNS', total, ZERO); add(cashAccount, ZERO, paid); add('1100-AR', ZERO, due);
      add('1200-INVENTORY', inventoryCost, ZERO); add('5100-COGS', ZERO, inventoryCost);
    }
    const debit = lines.reduce((sum, line) => sum + decimal(line.debit), ZERO);
    const credit = lines.reduce((sum, line) => sum + decimal(line.credit), ZERO);
    if (debit !== credit) throw new AppError(500, 'UNBALANCED_JOURNAL', 'القيد غير متوازن');
    return { id: randomUUID(), companyId: document.companyId, documentId: document.id, status: 'posted', currency: document.currency, lines };
  }

  #assertUnique(map, companyId, field, value, code) {
    if ([...map.values()].some((row) => row.companyId === companyId && row[field] === value)) throw new AppError(409, code, 'القيمة مستخدمة');
  }

  #change(companyId, entityType, entityId, action, payload) {
    this.changeSequence += 1;
    this.changes.push({ sequence: this.changeSequence, companyId, entityType, entityId, action, payload: clone(payload), changedAt: new Date().toISOString() });
  }

  #audit(companyId, actorUserId, action, entityType, entityId, metadata) {
    this.audit.push(Object.freeze({ id: randomUUID(), companyId, actorUserId, action, entityType, entityId, metadata: clone(metadata), createdAt: new Date().toISOString() }));
  }

  #publicCompany(company) {
    const { branches, ...publicCompany } = company;
    return clone({ ...publicCompany, branches });
  }

  #publicUser(user) {
    const { passwordHash, roleIds, ...publicUser } = user;
    return clone(publicUser);
  }
}

export { PERMISSIONS };

