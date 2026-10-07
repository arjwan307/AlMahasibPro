import { checkSales, salesRep, assignedSalesManager } from '../sales-workspace.js';
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
  async importFurnitureCatalog(companyId,actorUserId,catalog) {
    const company=this.companies.get(companyId);if(!company||company.status!=='active')throw new AppError(404,'COMPANY_NOT_FOUND','الشركة غير موجودة');
    const actor=this.users.get(actorUserId);if(!actor||actor.companyId!==companyId)throw new AppError(403,'USER_SCOPE','المستخدم خارج الشركة');
    const result={companyId,companyName:company.legalName,version:catalog.version,itemsCreated:0,warehousesCreated:0,pricesCreated:0,existingItems:0};
    let unit=[...this.units.values()].find(x=>x.companyId===companyId&&x.code==='FUR-UNIT');if(!unit)unit=await this.createUnit(companyId,{code:'FUR-UNIT',name:'وحدة أثاث / طقم',decimalPlaces:0},actorUserId);
    const warehouses=new Map();for(const definition of catalog.warehouses){let warehouse=[...this.warehouses.values()].find(x=>x.companyId===companyId&&x.code===definition.code);if(!warehouse){warehouse=await this.createWarehouse(companyId,{...definition,kind:'standard'},actorUserId);result.warehousesCreated++;}warehouses.set(definition.code,warehouse);}
    for(const definition of catalog.items){if([...this.items.values()].some(x=>x.companyId===companyId&&x.sku===definition.sku)){result.existingItems++;continue;}const warehouse=warehouses.get(definition.warehouseCode);if(!warehouse)throw new AppError(400,'WAREHOUSE_NOT_FOUND','مخزن الكتالوج غير موجود');const item=await this.createItem(companyId,{sku:definition.sku,name:definition.name,description:definition.metadata.description,category:definition.metadata.group,baseUnitId:unit.id},actorUserId);result.itemsCreated++;await this.saveSalesSetting('item:'+item.id,{...definition.metadata,companyId,defaultWarehouseId:warehouse.id,channel:'both',movement:'moving',maxDiscountPercent:'5.000000',reserved:{}},actorUserId);for(const [priceType,amount] of [['sale_retail',definition.retail],['sale_wholesale',definition.wholesale]]){await this.setPrice(companyId,{itemId:item.id,unitId:unit.id,priceType,currency:'IQD',amount:String(amount)},actorUserId);result.pricesCreated++;}this.stockBalances.set(companyId+':'+warehouse.id+':'+item.id,{companyId,warehouseId:warehouse.id,itemId:item.id,quantity:decimalString(decimal(String(definition.quantity??0),{nonNegative:true})),averageCost:'0.000000'});}
    this.#audit(companyId,actorUserId,'catalog.furniture.imported','catalog',catalog.version,result);return clone(result);
  }

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

  async registerCompany({ code, legalName, timezone, currency, phone, address, owner, product = null }) {
    if ([...this.companies.values()].some((company) => company.code === code)) {
      throw new AppError(409, 'COMPANY_CODE_EXISTS', 'رمز الشركة مستخدم');
    }
    const companyId = randomUUID();
    const now = new Date().toISOString();
    const branchId = randomUUID();
    const company = {
      id: companyId, code, legalName, timezone, currency, phone, address, product, status: 'pending',
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

  #validatedUserSalesProfile(companyId,input,roleCode,userId=null){
    if(input===undefined)return undefined;
    if(!input||typeof input!=='object'||!['none','representative','manager'].includes(input.kind))throw new AppError(400,'INVALID_SALES_PROFILE','حدد نوع الحساب');
    if(input.kind==='none'){if(roleCode==='representative')throw new AppError(400,'SALES_CHANNEL_REQUIRED','حدد مندوب مفرد أو جملة');return {companyId,channel:'retail',salesManager:false,managerUserId:null};}
    if(!['retail','wholesale'].includes(input.channel))throw new AppError(400,'SALES_CHANNEL_REQUIRED','حدد مفرد أو جملة');
    if(input.kind==='representative'&&roleCode!=='representative'||input.kind==='manager'&&roleCode==='representative')throw new AppError(400,'SALES_ROLE_MISMATCH','الدور لا يطابق نوع حساب المبيعات');
    const maxDiscountPercent=decimalString(decimal(input.maxDiscountPercent||'0',{nonNegative:true}));if(decimal(maxDiscountPercent)>decimal('100'))throw new AppError(400,'INVALID_DISCOUNT','الخصم لا يتجاوز ١٠٠٪');
    const result={companyId,channel:input.channel,salesManager:input.kind==='manager',managerUserId:null,phone:String(input.phone||'').slice(0,40),location:String(input.location||'').slice(0,200),maxDiscountPercent};
    if(input.kind==='representative'&&input.managerUserId){const manager=this.users.get(input.managerUserId),profile=this.salesSettings.get('user:'+input.managerUserId);if(input.managerUserId===userId||!manager||manager.companyId!==companyId||manager.status!=='active'||!profile?.salesManager||profile.channel!==input.channel)throw new AppError(400,'INVALID_SALES_MANAGER','اختر مدير مبيعات نشطًا من نفس النوع وفي شركتك');result.managerUserId=manager.id;}
    return result;
  }

  async createUser(companyId, input, actorUserId) {
    if ([...this.users.values()].some((user) => user.companyId === companyId && user.username === input.username)) {
      throw new AppError(409, 'USERNAME_EXISTS', 'اسم المستخدم مستخدم في الشركة');
    }
    const role = [...this.roles.values()].find((candidate) => candidate.companyId === companyId && candidate.code === input.roleCode);
    if (!role) throw new AppError(400, 'ROLE_NOT_FOUND', 'الدور غير موجود');
    const salesProfile=this.#validatedUserSalesProfile(companyId,input.salesProfile,input.roleCode);
    if(input.status!==undefined&&!['active','disabled'].includes(input.status))throw new AppError(400,'INVALID_STATUS','حالة الحساب غير صالحة');
    const defaultSalesPermissions=['catalog.read','customers.read','inventory.read','sales.read','sales.create','sales.approve','sales.return','sync.use'];
    if (input.permissions != null && (!Array.isArray(input.permissions) || input.permissions.some(value => !PERMISSIONS.includes(value) || value === 'company.approve'))) throw new AppError(400, 'INVALID_PERMISSIONS', 'الصلاحيات غير صالحة');
    const user = {
      id: randomUUID(), companyId, username: input.username, displayName: input.displayName,
      passwordHash: input.passwordHash, platformAdmin: false, status: input.status||'active', roleIds: [role.id], ...(input.permissions != null ? {permissions: [...input.permissions]} : salesProfile?.salesManager?{permissions:defaultSalesPermissions}:{}),
      scopes: input.scopes?.length ? clone(input.scopes) : [{ type: 'company', id: companyId }],
      createdAt: new Date().toISOString()
    };
    this.users.set(user.id, user);
    if(salesProfile)await this.saveSalesSetting('user:'+user.id,salesProfile,actorUserId);
    this.#audit(companyId, actorUserId, 'user.created', 'user', user.id, { roleCode: input.roleCode });
    this.#change(companyId, 'user', user.id, 'upsert', this.#publicUser(user));
    return this.#publicUser(user);
  }

  async listUsers(companyId) {
    return [...this.users.values()].filter(user => user.companyId === companyId).map(user => ({
      ...this.#publicUser(user), roleCode: this.roles.get(user.roleIds[0])?.code,
      salesProfile: {...clone(this.salesSettings.get('user:'+user.id)||{}),kind:this.salesSettings.get('user:'+user.id)?.salesManager?'manager':this.roles.get(user.roleIds[0])?.code==='representative'?'representative':'none'},
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
    const salesProfile=this.#validatedUserSalesProfile(companyId,input.salesProfile,input.roleCode,userId);
    const permissions = input.permissions ?? (salesProfile?.salesManager?['catalog.read','customers.read','inventory.read','sales.read','sales.create','sales.approve','sales.return','sync.use']:role.permissions);
    if (!Array.isArray(permissions) || permissions.some(value => !PERMISSIONS.includes(value) || value === 'company.approve')) throw new AppError(400, 'INVALID_PERMISSIONS', 'الصلاحيات غير صالحة');
    if (userId === actorUserId && (input.status !== 'active' || !permissions.includes('users.manage'))) throw new AppError(409, 'SELF_LOCKOUT', 'لا يمكنك إيقاف حسابك أو إزالة صلاحية إدارة المستخدمين منه');
    const managers = await this.listUsers(companyId);
    if (user.status === 'active' && managers.find(row => row.id === userId)?.permissions.includes('users.manage') && (input.status !== 'active' || !permissions.includes('users.manage')) && !managers.some(row => row.id !== userId && row.status === 'active' && row.permissions.includes('users.manage'))) throw new AppError(409, 'LAST_MANAGER', 'يجب إبقاء مسؤول نشط لإدارة المستخدمين');
    Object.assign(user, { username: input.username, displayName: input.displayName, status: input.status, roleIds: [role.id], permissions: [...permissions], updatedAt: new Date().toISOString() });
    if(salesProfile)await this.saveSalesSetting('user:'+userId,salesProfile,actorUserId);
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
    const item = { id: randomUUID(), companyId, sku: input.sku, name: input.name, description: String(input.description || '').slice(0,4000), category: input.category||'', baseUnitId: unit.id, active: true };
    this.items.set(item.id, item);
    const itemUnit = { id: randomUUID(), companyId, itemId: item.id, unitId: unit.id, conversionFactor: '1.000000', isBase: true };
    this.itemUnits.set(itemUnit.id, itemUnit);
    this.#audit(companyId, actorUserId, 'item.created', 'item', item.id, {});
    this.#change(companyId, 'item', item.id, 'upsert', { ...item, units: [itemUnit] });
    return clone({ ...item, units: [itemUnit] });
  }

  async listItemCategories(companyId){const defaults=['غرف نوم','تخم','مكتبي','منزلي','إنارة','أجهزة كهربائية'];return [...new Set([...defaults,...(this.salesSettings.get('categories:'+companyId)?.names||[])])];}
  async createItemCategory(companyId,name,actorUserId){name=String(name||'').trim();if(!name||name.length>100)throw new AppError(400,'INVALID_CATEGORY','اسم التصنيف مطلوب، بحد أقصى 100 حرف');const names=await this.listItemCategories(companyId);if(names.includes(name))throw new AppError(409,'CATEGORY_EXISTS','التصنيف موجود');names.push(name);await this.saveSalesSetting('categories:'+companyId,{companyId,names},actorUserId);return {name};}
  async updateItemDescription(companyId,itemId,description,actorUserId) {
    const item=this.items.get(itemId);if(!item||item.companyId!==companyId)throw new AppError(404,'ITEM_NOT_FOUND','المادة غير موجودة');
    item.description=String(description||'').slice(0,4000);this.#audit(companyId,actorUserId,'item.updated','item',itemId,{});this.#change(companyId,'item',itemId,'upsert',clone(item));return clone(item);
  }
  async deleteUnusedItem(companyId,itemId,actorUserId) {
    const item=this.items.get(itemId);if(!item||item.companyId!==companyId)throw new AppError(404,'ITEM_NOT_FOUND','المادة غير موجودة');
    const excluded=new Set(['items','itemUnits','prices','stockBalances','salesSettings']);
    for(const [key,value] of Object.entries(this)){if(excluded.has(key)||!(value instanceof Map))continue;if([...value.values()].some(row=>row.companyId===companyId&&JSON.stringify(row).includes(itemId)))throw new AppError(409,'ITEM_IN_USE','المادة مرتبطة بحركة أو مستند، لا يمكن حذفها');}
    if([...this.stockBalances.values()].some(x=>x.companyId===companyId&&x.itemId===itemId&&Number(x.quantity)!==0))throw new AppError(409,'ITEM_IN_USE','للمادة رصيد، لا يمكن حذفها');
    if([...this.salesApprovals.values()].some(x=>JSON.stringify(x).includes(itemId)))throw new AppError(409,'ITEM_IN_USE','المادة مرتبطة بطلب موافقة');
    for(const map of [this.itemUnits,this.prices,this.stockBalances])for(const [key,row] of map)if(row.companyId===companyId&&row.itemId===itemId)map.delete(key);
    this.salesSettings.delete('item:'+itemId);this.items.delete(itemId);this.#audit(companyId,actorUserId,'item.deleted','item',itemId,{});this.#change(companyId,'item',itemId,'delete',{id:itemId});return {deleted:true};
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
    const party = { id: randomUUID(), companyId, code: input.code, name: input.name, phone: input.phone || null,
      ...(type === 'customer' ? { province: input.province || '', district: input.district || '', address: input.address || '', paymentPreference: ['cash','credit','mixed'].includes(input.paymentPreference) ? input.paymentPreference : 'cash', salesChannel: input.salesChannel === 'wholesale' ? 'wholesale' : 'retail' } : { country: input.country || '', companyName: input.companyName || '', specialty: input.specialty || '', relationshipStartYear: input.relationshipStartYear || '' }), active: true };
    if (type === 'customer') party.creditLimit = decimalString(decimal(input.creditLimit || '0', { nonNegative: true }));
    map.set(party.id, party);
    this.#audit(companyId, actorUserId, `${type}.created`, type, party.id, {});
    this.#change(companyId, type, party.id, 'upsert', party);
    return clone(party);
  }

  async updateSupplier(companyId, supplierId, input, actorUserId) {
    const supplier = this.suppliers.get(supplierId);
    if (!supplier || supplier.companyId !== companyId) throw new AppError(404, 'SUPPLIER_NOT_FOUND', 'المورد غير موجود');
    if (input.code && input.code !== supplier.code) this.#assertUnique(this.suppliers, companyId, 'code', input.code, 'SUPPLIER_CODE_EXISTS');
    const next = { ...supplier,
      code: input.code || supplier.code,
      name: input.name || supplier.name,
      phone: input.phone ?? supplier.phone,
      country: input.country ?? supplier.country,
      companyName: input.companyName ?? supplier.companyName,
      specialty: input.specialty ?? supplier.specialty,
      relationshipStartYear: input.relationshipStartYear ?? supplier.relationshipStartYear
    };
    this.suppliers.set(supplierId, next);
    this.#audit(companyId, actorUserId, 'supplier.updated', 'supplier', supplierId, {});
    this.#change(companyId, 'supplier', supplierId, 'upsert', next);
    return clone(next);
  }

  async deleteSupplier(companyId, supplierId, actorUserId) {
    const supplier = this.suppliers.get(supplierId);
    if (!supplier || supplier.companyId !== companyId) throw new AppError(404, 'SUPPLIER_NOT_FOUND', 'المورد غير موجود');
    const referenced = [...this.commerceDocuments.values()].some(row => row.companyId === companyId && row.supplierId === supplierId);
    if (referenced) throw new AppError(409, 'SUPPLIER_HAS_DOCUMENTS', 'لا يمكن حذف مورد مرتبط بفواتير؛ ألغِ مستنداته محاسبيًا أولًا');
    this.suppliers.delete(supplierId);
    this.#audit(companyId, actorUserId, 'supplier.deleted', 'supplier', supplierId, {});
    this.#change(companyId, 'supplier', supplierId, 'delete', { id: supplierId });
    return { id: supplierId };
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
      categories: await this.listItemCategories(companyId),
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
    const cash = input.method === 'cash' ? '1000-CASH' : '1010-BANK';
    const lines = document.documentType === 'sale' ? [[cash,amount,ZERO],['1100-AR',ZERO,amount]] : [['2100-AP',amount,ZERO],[cash,ZERO,amount]];
    const journal = this.#simpleJournal(context, input, input.receiptNumber, document.currency, lines);
    const row = { id: randomUUID(), companyId: context.company.id, kind: 'enterprise_settlement', operationId: input.operationId, documentId: document.id, receiptNumber: input.receiptNumber, amount: decimalString(amount), currency: document.currency, receivedAmount: input.receivedAmount || decimalString(amount), receivedCurrency: input.receivedCurrency || document.currency, exchangeRate: input.exchangeRate || '1.000000', method: input.method, bankName: input.bankName || '', transactionNumber: input.transactionNumber || '', journalEntryId: journal.id, occurredAt: input.occurredAt, createdBy: context.user.id };
    this.financialRecords.set(row.id, Object.freeze(row));
    this.#audit(context.company.id,context.user.id,'enterprise.settlement','financial_record',row.id,{});
    this.#change(context.company.id,'financial_record',row.id,'upsert',row);
    return clone(row);
  }

  async listCustomerAccountSummaries(companyId) {
    const company = this.companies.get(companyId), currency = company?.currency || 'IQD', result = {};
    for (const customer of this.customers.values()) {
      if (customer.companyId !== companyId) continue;
      const movements = [...this.debtMovements.values()].filter((m) => m.companyId === companyId && m.customerId === customer.id && m.currency === currency);
      const documents = [...this.commerceDocuments.values()].filter((d) => d.companyId === companyId && d.customerId === customer.id && d.currency === currency);
      const paymentEvents = [
        ...documents.filter((d) => decimal(d.paidAmount || '0') > ZERO).map((d) => ({ at: d.occurredAt, amount: d.paidAmount })),
        ...movements.filter((m) => m.movementType === 'collection').map((m) => ({ at: m.occurredAt, amount: decimalString(-decimal(m.amount)) }))
      ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const lastMovement = [...movements.map((m) => m.occurredAt), ...documents.map((d) => d.occurredAt)].sort().at(-1) || null;
      const balance = movements.reduce((sum, m) => sum + decimal(m.amount), ZERO);
      const paidTotal = documents.reduce((sum, d) => sum + decimal(d.paidAmount || '0'), ZERO)
        + movements.filter((m) => m.movementType === 'collection').reduce((sum, m) => sum - decimal(m.amount), ZERO);
      result[customer.id] = {
        lastMovementAt: lastMovement, lastPaymentAt: paymentEvents.at(-1)?.at || null,
        lastPaymentAmount: paymentEvents.at(-1)?.amount || '0.000000',
        paidTotal: decimalString(paidTotal), outstanding: decimalString(balance), currency
      };
    }
    return result;
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
  async adjustPayrollCycle(context,id,input){const cycle=this.#payrollCycle(context.company.id,id);if(!['approved','paid'].includes(cycle.status))throw new AppError(409,'PAYROLL_NOT_LOCKED','التسوية بعد اعتماد الدورة فقط');this.#employee(context.company.id,input.employeeId);const existing=[...this.payrollAdjustments.values()].find(x=>x.companyId===context.company.id&&x.operationId===input.operationId);if(existing)return clone(existing);const amount=decimal(input.amount,{positive:true});const lines=input.adjustmentType==='earning'?[['6100-PAYROLL-EXPENSE',amount,ZERO],['2300-PAYROLL-PAYABLE',ZERO,amount]]:[['1400-EMPLOYEE-RECEIVABLE',amount,ZERO],['6150-PAYROLL-RECOVERY',ZERO,amount]];const journal=this.#simpleJournal(context,{operationId:input.operationId,occurredAt:input.occurredAt},`ADJ-${input.adjustmentNumber}`,input.currency,lines);const row={id:randomUUID(),companyId:context.company.id,cycleId:id,employeeId:input.employeeId,adjustmentNumber:input.adjustmentNumber,adjustmentType:input.adjustmentType,amount:decimalString(amount),currency:input.currency,reason:input.reason,operationId:input.operationId,journalEntryId:journal.id,createdBy:context.user.id,createdAt:input.occurredAt};this.payrollAdjustments.set(row.id,Object.freeze(row));this.#audit(context.company.id,context.user.id,'payroll.adjustment.posted','payroll_adjustment',row.id,{cycleId:id});return clone(row);}

  async setBarcode(companyId, input, actorUserId) {
    if ([...this.itemBarcodes.values()].some((row) => row.companyId === companyId && row.barcode === input.barcode)) throw new AppError(409, 'BARCODE_EXISTS', 'الباركود مستخدم');
    const relation = [...this.itemUnits.values()].find((row) => row.companyId === companyId && row.itemId === input.itemId && row.unitId === input.unitId);
    if (!relation) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
    const barcode = { id: randomUUID(), companyId, ...input };
    this.itemBarcodes.set(barcode.id, barcode);
    this.#audit(companyId, actorUserId, 'barcode.created', 'item_barcode', barcode.id, {});
    this.#change(companyId, 'item_barcode', barcode.id, 'upsert', barcode);
    return clone(barcode);
  }

  async createPosDevice(companyId, input, actorUserId) {
    if ([...this.posDevices.values()].some((row) => row.companyId === companyId && (row.id === input.id || row.code === input.code))) throw new AppError(409, 'POS_DEVICE_EXISTS', 'جهاز الكاشير موجود');
    const warehouse = this.warehouses.get(input.warehouseId);
    if (!warehouse || warehouse.companyId !== companyId) throw new AppError(400, 'WAREHOUSE_NOT_FOUND', 'المخزن غير موجود');
    const device = { id: input.id, companyId, warehouseId: input.warehouseId, branchId: input.branchId || null, code: input.code, name: input.name, interfaceMode: input.interfaceMode, offlineEnabled: true, active: true };
    this.posDevices.set(device.id, device);
    this.posDiscountPolicies.set(device.id, { companyId, deviceId: device.id, maxDiscountPercent: input.maxDiscountPercent || '0.000000' });
    this.#audit(companyId, actorUserId, 'pos.device.created', 'pos_device', device.id, {});
    this.#change(companyId, 'pos_device', device.id, 'upsert', device);
    return clone(device);
  }

  async setPosAllocation(companyId, deviceId, input, actorUserId) {
    const device = this.posDevices.get(deviceId);
    if (!device || device.companyId !== companyId) throw new AppError(404, 'POS_DEVICE_NOT_FOUND', 'جهاز الكاشير غير موجود');
    const amount = decimal(input.quantity, { nonNegative: true });
    const balance = this.stockBalances.get(`${companyId}:${device.warehouseId}:${input.itemId}`);
    const reservedOther = [...this.offlineAllocations.values()].filter((row) => row.companyId === companyId && row.itemId === input.itemId && row.deviceId !== deviceId)
      .reduce((sum, row) => sum + decimal(row.allocatedQuantity) - decimal(row.consumedQuantity), ZERO);
    if (!balance || decimal(balance.quantity) - reservedOther < amount) throw new AppError(409, 'ALLOCATION_EXCEEDS_STOCK', 'المخصص يتجاوز المخزون المتاح');
    const key = `${companyId}:${deviceId}:${input.itemId}`;
    const old = this.offlineAllocations.get(key);
    if (old && decimal(old.consumedQuantity) > amount) throw new AppError(409, 'ALLOCATION_BELOW_CONSUMED', 'لا يمكن خفض المخصص دون المستهلك');
    const allocation = { companyId, deviceId, warehouseId: device.warehouseId, itemId: input.itemId, allocatedQuantity: decimalString(amount), consumedQuantity: old?.consumedQuantity || '0.000000', version: (old?.version || 0) + 1, expiresAt: input.expiresAt || null };
    this.offlineAllocations.set(key, allocation);
    this.#audit(companyId, actorUserId, 'pos.allocation.updated', 'offline_allocation', input.itemId, { deviceId });
    this.#change(companyId, 'offline_allocation', input.itemId, 'upsert', allocation);
    return clone(allocation);
  }

  async getPosBootstrap(companyId, deviceId) {
    const device = this.posDevices.get(deviceId);
    if (!device || device.companyId !== companyId || !device.active) throw new AppError(404, 'POS_DEVICE_NOT_FOUND', 'جهاز الكاشير غير موجود');
    const openShift = [...this.posShifts.values()].find((shift) => shift.companyId === companyId && shift.deviceId === deviceId && shift.status !== 'closed') || null;
    const allocations = [...this.offlineAllocations.values()].filter((row) => row.companyId === companyId && row.deviceId === deviceId).map(clone);
    const barcodes = [...this.itemBarcodes.values()].filter((row) => row.companyId === companyId).map((row) => {
      const relation = [...this.itemUnits.values()].find((unit) => unit.companyId === companyId && unit.itemId === row.itemId && unit.unitId === row.unitId);
      const price = [...this.prices.values()].filter((entry) => entry.companyId === companyId && entry.itemId === row.itemId && entry.unitId === row.unitId && entry.priceType === 'sale').at(-1);
      return { ...clone(row), item: clone(this.items.get(row.itemId)), conversionFactor: relation.conversionFactor, salePrice: price?.amount || null, currency: price?.currency || null };
    });
    return {
      device: clone(device), shift: openShift ? clone(openShift) : null, allocations, barcodes,
      customers: [...this.customers.values()].filter((row) => row.companyId === companyId && row.active).map(clone),
      discountPolicy: clone(this.posDiscountPolicies.get(deviceId))
    };
  }

  async createRepresentative(companyId, input, actorUserId) {
    const user = this.users.get(input.userId);
    const warehouse = this.warehouses.get(input.vehicleWarehouseId);
    if (!user || user.companyId !== companyId) throw new AppError(400, 'USER_NOT_FOUND', 'مستخدم المندوب غير موجود');
    if (!warehouse || warehouse.companyId !== companyId || warehouse.kind !== 'vehicle') throw new AppError(400, 'VEHICLE_WAREHOUSE_REQUIRED', 'يجب تحديد مخزن سيارة من الشركة');
    if ([...this.representatives.values()].some((row) => row.companyId === companyId && (row.userId === input.userId || row.code === input.code))) throw new AppError(409, 'REPRESENTATIVE_EXISTS', 'المندوب موجود');
    const row = { id: randomUUID(), companyId, userId: input.userId, vehicleWarehouseId: input.vehicleWarehouseId, code: input.code, name: input.name, deviceId: input.deviceId || null, active: true };
    this.representatives.set(row.id, row); this.#audit(companyId, actorUserId, 'representative.created', 'representative', row.id, {}); this.#change(companyId, 'representative', row.id, 'upsert', row);
    return clone(row);
  }

  async assignRepresentativeCustomer(companyId, representativeId, input, actorUserId) {
    const rep = this.representatives.get(representativeId); const customer = this.customers.get(input.customerId);
    if (!rep || rep.companyId !== companyId || !customer || customer.companyId !== companyId) throw new AppError(404, 'REPRESENTATIVE_OR_CUSTOMER_NOT_FOUND', 'المندوب أو العميل غير موجود');
    const row = { companyId, representativeId, customerId: input.customerId, visitOrder: input.visitOrder || 0, creditLimit: input.creditLimit ?? null, active: true };
    this.representativeCustomers.set(`${companyId}:${representativeId}:${input.customerId}`, row); this.#audit(companyId, actorUserId, 'representative.customer.assigned', 'representative_customer', input.customerId, { representativeId });
    return clone(row);
  }

  async createRepresentativeRoute(companyId, representativeId, input, actorUserId) {
    const rep = this.representatives.get(representativeId);
    if (!rep || rep.companyId !== companyId) throw new AppError(404, 'REPRESENTATIVE_NOT_FOUND', 'المندوب غير موجود');
    const stops = input.stops.map((stop, index) => {
      const assignment = this.representativeCustomers.get(`${companyId}:${representativeId}:${stop.customerId}`);
      if (!assignment?.active) throw new AppError(400, 'CUSTOMER_NOT_ASSIGNED', 'أحد العملاء غير مسند للمندوب');
      return { customerId: stop.customerId, stopOrder: stop.stopOrder || index + 1, note: stop.note || null };
    });
    const route = { id: randomUUID(), companyId, representativeId, code: input.code, name: input.name, routeDate: input.routeDate || null, active: true, stops };
    this.representativeRoutes.set(route.id, route); this.#audit(companyId, actorUserId, 'representative.route.created', 'representative_route', route.id, {}); this.#change(companyId, 'representative_route', route.id, 'upsert', route);
    return clone(route);
  }

  async getRepresentativeBootstrap(context, representativeId = null) {
    const companyId = context.company.id;
    const rep = representativeId ? this.representatives.get(representativeId) : [...this.representatives.values()].find((row) => row.companyId === companyId && row.userId === context.user.id);
    if (!rep || rep.companyId !== companyId || (!context.permissions.includes('representatives.manage') && rep.userId !== context.user.id)) throw new AppError(404, 'REPRESENTATIVE_NOT_FOUND', 'ملف المندوب غير موجود');
    const assignments = [...this.representativeCustomers.values()].filter((row) => row.companyId === companyId && row.representativeId === rep.id && row.active);
    const debt = (customerId) => [...this.debtMovements.values()].filter((row) => row.companyId === companyId && row.customerId === customerId).reduce((sum, row) => sum + decimal(row.amount), ZERO);
    const custody = [...this.custodyMovements.values()].filter((row) => row.companyId === companyId && row.representativeId === rep.id).reduce((sum, row) => sum + decimal(row.amount), ZERO);
    const catalog = [...this.itemUnits.values()].filter((row) => row.companyId === companyId).map((row) => { const item=this.items.get(row.itemId); const price=[...this.prices.values()].filter((p)=>p.companyId===companyId&&p.itemId===row.itemId&&p.unitId===row.unitId&&p.priceType==='sale').at(-1); const barcode=[...this.itemBarcodes.values()].find((b)=>b.companyId===companyId&&b.itemId===row.itemId&&b.unitId===row.unitId); return {itemId:row.itemId,unitId:row.unitId,sku:item.sku,name:item.name,conversionFactor:row.conversionFactor,salePrice:price?.amount||null,barcode:barcode?.barcode||item.sku}; });
    return { representative: clone(rep), customers: assignments.map((a) => ({ ...clone(this.customers.get(a.customerId)), assignment: clone(a), debt: decimalString(debt(a.customerId)) })), routes: [...this.representativeRoutes.values()].filter((r) => r.companyId === companyId && r.representativeId === rep.id).map(clone), stock: [...this.stockBalances.values()].filter((s) => s.companyId === companyId && s.warehouseId === rep.vehicleWarehouseId).map(clone), warehouses:[...this.warehouses.values()].filter(w=>w.companyId===companyId&&w.active).map(clone), catalog, custody: decimalString(custody), orders: [...this.representativeOrders.values()].filter((o) => o.companyId === companyId && o.representativeId === rep.id).map(clone), handovers: [...this.representativeHandovers.values()].filter((h) => h.companyId === companyId && h.representativeId === rep.id).map(clone), conflicts: [...this.syncConflicts.values()].filter((c) => c.companyId === companyId && c.userId === context.user.id).map(clone) };
  }

  async pushOperations(context, operations) {
    const results = [];
    for (const operation of operations) {
      const key = `${context.company.id}:${operation.operationId}`;
      const existing = this.operations.get(key);
      if (existing) {
        if (existing.payloadHash !== operation.payloadHash) {
          results.push({ operationId: operation.operationId, status: 'rejected', code: 'OPERATION_ID_REUSED' });
        } else {
          results.push(clone(existing.result));
        }
        continue;
      }
      const result = {
        operationId: operation.operationId, status: 'acknowledged', serverReceivedAt: new Date().toISOString()
      };
      if (operation.type === 'attendance.check_in' || operation.type === 'attendance.check_out') {
        try { const event=this.#commitAttendance(context,operation);result.entityId=event.id;result.attendance=event; }
        catch(error){if(!(error instanceof AppError))throw error;result.status='rejected';result.code=error.code;result.message=error.message;}
      } else if (operation.type.startsWith('representative.')) {
        const snapshot = this.#representativeTransactionSnapshot();
        try {
          Object.assign(result, this.#commitRepresentativeOperation(context, operation));
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          this.#restoreRepresentativeTransaction(snapshot);
          result.status = 'rejected'; result.code = error.code; result.message = error.message;
        }
      } else if (operation.type === 'pos.shift.open') {
        try {
          const shift = this.#openPosShift(context, operation);
          result.entityId = shift.id; result.shift = shift;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          result.status = 'rejected'; result.code = error.code; result.message = error.message;
        }
      } else if (operation.type === 'pos.sale' || operation.type === 'pos.return') {
        try {
          const posResult = this.#commitPosDocument(context, operation);
          result.entityId = posResult.document.id; Object.assign(result, posResult);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          result.status = 'rejected'; result.code = error.code; result.message = error.message;
        }
      } else if (operation.type === 'pos.shift.close') {
        try {
          const shift = this.#closePosShift(context, operation);
          result.entityId = shift.id; result.shift = shift;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          result.status = 'rejected'; result.code = error.code; result.message = error.message;
        }
      } else if (operation.type === 'commerce.commit') {
        try {
          const document = this.#commitCommerce(context, operation);
          result.entityId = document.id;
          result.document = document;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          result.status = 'rejected';
          result.code = error.code;
          result.message = error.message;
        }
      } else if (operation.type === 'financial.record') {
        if (typeof operation.payload.kind !== 'string' || !/^-?\d+(\.\d{1,6})?$/.test(String(operation.payload.amount)) || !/^[A-Z]{3}$/.test(operation.payload.currency || '')) {
          result.status = 'rejected';
          result.code = 'INVALID_FINANCIAL_PAYLOAD';
        } else {
          const record = {
            id: randomUUID(), companyId: context.company.id, sourceOperationId: operation.operationId,
            kind: operation.payload.kind, amount: String(operation.payload.amount), currency: operation.payload.currency,
            occurredAt: operation.occurredAt, createdBy: context.user.id, createdAt: result.serverReceivedAt
          };
          this.financialRecords.set(record.id, Object.freeze(record));
          result.entityId = record.id;
          this.#change(context.company.id, 'financial_record', record.id, 'upsert', record);
        }
      } else if (operation.type.startsWith('draft.')) {
        const entityId = String(operation.payload.entityId || randomUUID());
        result.entityId = entityId;
        this.#change(context.company.id, 'draft', entityId, 'upsert', clone(operation.payload));
      } else if (operation.type.startsWith('market.transaction.')) {
        const p = operation.payload || {}, entityId = String(p.id || operation.operationId);
        let marketError=null;
        if(['cash_in','collection'].includes(p.kind)){
          const amount=Number(p.amount);
          if(!Number.isFinite(amount)||amount<=0||!p.shiftId)marketError='INVALID_MARKET_CASH';
          if(p.kind==='collection'){
            const records=this.changes.filter(x=>x.companyId===context.company.id&&x.entityType==='market.transaction').map(x=>x.payload||x.data||{}),sale=records.find(x=>x.kind==='sale'&&x.invoice===p.invoice);
            const paid=records.filter(x=>x.kind==='collection'&&x.invoice===p.invoice).reduce((n,x)=>n+Number(x.amount||0),0),returns=records.filter(x=>x.kind==='return'&&x.invoice===p.invoice).reduce((n,x)=>n+Number(x.amount||0),0);
            if(!sale||records.some(x=>x.kind==='cancel'&&x.invoice===p.invoice)||amount>Math.max(0,Number(sale.net||0)-Number(sale.cash??sale.net??0)-paid-returns)+0.0000001)marketError='MARKET_COLLECTION_EXCEEDS_BALANCE';
          }
        }
        if(marketError){result.status='rejected';result.code=marketError;}
        else if (!['sale','return','cancel','shift_open','shift_close','expense','cash_in','collection','waiting_update','waiting_close','drawer_open','drawer_result'].includes(String(p.kind || ''))) {
          result.status = 'rejected'; result.code = 'INVALID_MARKET_TRANSACTION';
        } else {
          result.entityId = entityId;
          this.#change(context.company.id, 'market.transaction', entityId, 'upsert', {
            ...clone(p), id: entityId, kind: String(p.kind), cashier: String(p.cashier || ''), cashierCode: String(p.cashierCode || ''),
            occurredAt: p.occurredAt || operation.occurredAt
          });
        }
      } else if (operation.type === 'market.snapshot') {
        const catalog = Array.isArray(operation.payload?.catalog) ? operation.payload.catalog : null;
        if (!catalog) {
          result.status = 'rejected';
          result.code = 'INVALID_MARKET_CATALOG';
        } else {
          const entityId = 'catalog';
          result.entityId = entityId;
          this.#change(context.company.id, 'market.snapshot', entityId, 'upsert', {
            catalog: clone(catalog), updatedAt: operation.payload.updatedAt || operation.occurredAt
          });
        }
      } else if (operation.type.startsWith('draft.')) {
        const entityId = operation.payload.entityId || randomUUID();
        result.entityId = entityId;
        this.#change(context.company.id, 'draft', entityId, operation.type === 'draft.delete' ? 'tombstone' : 'upsert', operation.payload);
      } else {
        result.status = 'rejected';
        result.code = 'UNSUPPORTED_OPERATION';
      }
      this.operations.set(key, { ...clone(operation), companyId: context.company.id, userId: context.user.id, result: clone(result) });
      if (result.status === 'rejected' && operation.type.startsWith('representative.')) {
        const conflict = { id: randomUUID(), companyId: context.company.id, userId: context.user.id, deviceId: operation.deviceId, operationId: operation.operationId, code: result.code, message: result.message || null, createdAt: result.serverReceivedAt };
        this.syncConflicts.set(operation.operationId, conflict);
      }
      results.push(result);
    }
    return results;
  }

  async pullChanges(companyId, cursor = 0, limit = 100) {
    const changes = this.changes.filter((change) => change.companyId === companyId && change.sequence > cursor).slice(0, limit);
    return { changes: clone(changes), nextCursor: changes.at(-1)?.sequence ?? cursor, hasMore: changes.length === limit };
  }

  async syncStatus(companyId, userId, deviceId) {
    const operations = [...this.operations.values()].filter((operation) => operation.companyId === companyId && operation.userId === userId && (!deviceId || operation.deviceId === deviceId));
    return {
      acknowledged: operations.filter((operation) => operation.result.status === 'acknowledged').length,
      rejected: operations.filter((operation) => operation.result.status === 'rejected').length,
      conflicts: [...this.syncConflicts.values()].filter((row) => row.companyId === companyId && row.userId === userId && (!deviceId || row.deviceId === deviceId) && !row.resolvedAt).length,
      lastServerCursor: this.changes.filter((change) => change.companyId === companyId).at(-1)?.sequence ?? 0
    };
  }

  #commitAttendance(context,operation){const p=operation.payload,c=context.company.id,employee=this.#employee(c,p.employeeId);if(employee.userId!==context.user.id&&!context.permissions.includes('attendance.manage'))throw new AppError(403,'EMPLOYEE_SCOPE_DENIED','لا يمكن تسجيل حضور موظف آخر');const events=[...this.attendanceEvents.values()].filter(x=>x.companyId===c&&x.employeeId===employee.id).sort((a,b)=>String(a.eventTime).localeCompare(String(b.eventTime)));const expected=events.at(-1)?.eventType==='check_in'?'check_out':'check_in';const actual=operation.type==='attendance.check_in'?'check_in':'check_out';if(actual!==expected)throw new AppError(409,actual==='check_in'?'ATTENDANCE_ALREADY_OPEN':'ATTENDANCE_NOT_OPEN','تسلسل الحضور والانصراف غير صالح');const row={id:p.eventId,companyId:c,employeeId:employee.id,eventType:actual,eventTime:p.eventTime,source:p.source,operationId:operation.operationId,deviceId:operation.deviceId,createdBy:context.user.id};this.attendanceEvents.set(row.id,Object.freeze(row));this.#audit(c,context.user.id,`attendance.${actual}`,'attendance_event',row.id,{});this.#change(c,'attendance_event',row.id,'upsert',row);return clone(row);}

  #commitRepresentativeOperation(context, operation) {
    const p = operation.payload; const companyId = context.company.id;
    const rep = this.representatives.get(p.representativeId);
    if (!rep || rep.companyId !== companyId || !rep.active) throw new AppError(404, 'REPRESENTATIVE_NOT_FOUND', 'المندوب غير موجود');
    const own = rep.userId === context.user.id;
    if (operation.type === 'representative.load' && !context.permissions.includes('representatives.manage')) throw new AppError(403, 'PERMISSION_DENIED', 'تحميل السيارة يحتاج صلاحية الإدارة');
    if (operation.type === 'representative.handover.review' && !context.permissions.includes('representatives.review')) throw new AppError(403, 'PERMISSION_DENIED', 'مراجعة التسليم تحتاج صلاحية المشرف');
    if (!['representative.load', 'representative.handover.review'].includes(operation.type) && !own && !context.permissions.includes('representatives.manage')) throw new AppError(403, 'REPRESENTATIVE_SCOPE_DENIED', 'لا يمكن تنفيذ عملية لمندوب آخر');
    if (operation.type === 'representative.load') return { transfer: this.#transferRepresentativeStock(context, operation, p.sourceWarehouseId, rep.vehicleWarehouseId, p.lines, p.transferNumber, rep.id) };
    if (operation.type === 'representative.order') {
      this.#assertAssignedCustomer(companyId, rep.id, p.customerId);
      let total = ZERO; const lines = p.lines.map((line) => { const q = decimal(line.quantity, { positive: true }); const price = decimal(line.unitPrice, { nonNegative: true }); const lineTotal = multiply(q, price); total += lineTotal; return { ...clone(line), quantity: decimalString(q), unitPrice: decimalString(price), lineTotal: decimalString(lineTotal) }; });
      const order = { id: p.orderId, companyId, representativeId: rep.id, customerId: p.customerId, orderNumber: p.orderNumber, currency: p.currency, total: decimalString(total), status: 'pending', operationId: operation.operationId, occurredAt: operation.occurredAt, createdBy: context.user.id, lines };
      this.representativeOrders.set(order.id, order); this.#change(companyId, 'representative_order', order.id, 'upsert', order); return { entityId: order.id, order: clone(order) };
    }
    if (operation.type === 'representative.sale' || operation.type === 'representative.return') {
      this.#assertAssignedCustomer(companyId, rep.id, p.partyId);
      const isReturn = operation.type.endsWith('return');
      const pendingOrder=p.orderId?this.representativeOrders.get(p.orderId):null; if(p.orderId&&(!pendingOrder||pendingOrder.companyId!==companyId||pendingOrder.representativeId!==rep.id||pendingOrder.status!=='pending')) throw new AppError(409,'ORDER_NOT_PENDING','الطلب غير صالح للتحويل');
      if (!isReturn) {
        const assignment = this.representativeCustomers.get(`${companyId}:${rep.id}:${p.partyId}`); const customer = this.customers.get(p.partyId);
        const limit = decimal(assignment.creditLimit ?? customer.creditLimit ?? '0', { nonNegative: true });
        const currentDebt = [...this.debtMovements.values()].filter((m) => m.companyId === companyId && m.customerId === p.partyId && m.currency === p.currency).reduce((s, m) => s + decimal(m.amount), ZERO);
        const total = p.lines.reduce((s, l) => s + multiply(decimal(l.quantity), decimal(l.unitPrice)), ZERO) - decimal(p.discountAmount || '0');
        const paid = (p.payments || []).reduce((s, x) => s + decimal(x.amount), ZERO);
        if (currentDebt + total - paid > limit) throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', 'البيع يتجاوز حد ائتمان العميل');
      } else {
        const original=this.commerceDocuments.get(p.originalDocumentId); if(!original||original.companyId!==companyId||original.representativeId!==rep.id) throw new AppError(403,'RETURN_REPRESENTATIVE_MISMATCH','لا يمكن إرجاع بيع مندوب آخر');
        const refund=(p.payments||[]).reduce((s,x)=>s+decimal(x.amount),ZERO); const custody=[...this.custodyMovements.values()].filter(m=>m.companyId===companyId&&m.representativeId===rep.id&&m.currency===p.currency).reduce((s,m)=>s+decimal(m.amount),ZERO); if(refund>custody) throw new AppError(409,'REFUND_EXCEEDS_CUSTODY','نقد المرتجع يتجاوز عهدة المندوب');
      }
      const document = this.#commitCommerce(context, { ...operation, payload: { ...p, representativeId: rep.id, warehouseId: rep.vehicleWarehouseId, documentType: isReturn ? 'sale_return' : 'sale' } });
      if (pendingOrder) { pendingOrder.status = 'converted'; pendingOrder.saleDocumentId = document.id; }
      return { entityId: document.id, document };
    }
    if (operation.type === 'representative.collection') {
      this.#assertAssignedCustomer(companyId, rep.id, p.customerId); const amount = decimal(p.amount, { positive: true });
      const debt = [...this.debtMovements.values()].filter((m) => m.companyId === companyId && m.customerId === p.customerId && m.currency === p.currency).reduce((s, m) => s + decimal(m.amount), ZERO);
      if (amount > debt) throw new AppError(409, 'COLLECTION_EXCEEDS_DEBT', 'التحصيل يتجاوز دين العميل');
      const collection = { id: randomUUID(), companyId, representativeId: rep.id, customerId: p.customerId, receiptNumber: p.receiptNumber, amount: decimalString(amount), currency: p.currency, operationId: operation.operationId, occurredAt: operation.occurredAt, createdBy: context.user.id };
      this.representativeCollections.set(collection.id, Object.freeze(collection)); this.#recordDebt(companyId, p.customerId, rep.id, null, operation, 'collection', -amount, p.currency); this.#recordCustody(companyId, rep.id, operation, 'collection', amount, p.currency, 'collection', collection.id); this.#simpleJournal(context, operation, `COL-${p.receiptNumber}`, p.currency, [['1150-REP-CASH-CUSTODY', amount, ZERO], ['1100-AR', ZERO, amount]]); this.#change(companyId, 'representative_collection', collection.id, 'upsert', collection); return { entityId: collection.id, collection: clone(collection) };
    }
    if (operation.type === 'representative.handover.submit') {
      const custody = [...this.custodyMovements.values()].filter((m) => m.companyId === companyId && m.representativeId === rep.id && m.currency === p.currency).reduce((s, m) => s + decimal(m.amount), ZERO);
      const submitted = decimal(p.submittedCash, { nonNegative: true });
      for (const line of p.lines || []) { const balance = this.stockBalances.get(`${companyId}:${rep.vehicleWarehouseId}:${line.itemId}`); if (!balance || decimal(balance.quantity) < decimal(line.quantity, { positive: true })) throw new AppError(409, 'INSUFFICIENT_VEHICLE_STOCK', 'بضاعة السيارة لا تكفي للتسليم'); }
      const handover = { id: p.handoverId, companyId, representativeId: rep.id, destinationWarehouseId: p.destinationWarehouseId, handoverNumber: p.handoverNumber, expectedCash: decimalString(custody), submittedCash: decimalString(submitted), reviewedCash: null, cashVariance: null, currency: p.currency, status: 'submitted', submitOperationId: operation.operationId, submittedAt: operation.occurredAt, submittedBy: context.user.id, lines: clone(p.lines || []) };
      this.representativeHandovers.set(handover.id, handover); this.#change(companyId, 'representative_handover', handover.id, 'upsert', handover); return { entityId: handover.id, handover: clone(handover) };
    }
    if (operation.type === 'representative.handover.review') {
      const handover = this.representativeHandovers.get(p.handoverId); if (!handover || handover.companyId !== companyId || handover.status !== 'submitted') throw new AppError(409, 'HANDOVER_NOT_SUBMITTED', 'التسليم غير متاح للمراجعة');
      const reviewed = decimal(p.reviewedCash, { nonNegative: true }); const custody = [...this.custodyMovements.values()].filter((m) => m.companyId === companyId && m.representativeId === rep.id && m.currency === handover.currency).reduce((s, m) => s + decimal(m.amount), ZERO); if (reviewed > custody) throw new AppError(409, 'HANDOVER_EXCEEDS_CUSTODY', 'النقد المراجع يتجاوز العهدة');
      if (handover.lines.length) this.#transferRepresentativeStock(context, operation, rep.vehicleWarehouseId, handover.destinationWarehouseId, handover.lines, `RET-${handover.handoverNumber}`, rep.id);
      this.#recordCustody(companyId, rep.id, operation, 'cash_handover', -reviewed, handover.currency, 'handover', handover.id); this.#simpleJournal(context, operation, `HND-${handover.handoverNumber}`, handover.currency, [['1000-CASH', reviewed, ZERO], ['1150-REP-CASH-CUSTODY', ZERO, reviewed]]);
      handover.status = 'reviewed'; handover.reviewedCash = decimalString(reviewed); handover.cashVariance = decimalString(reviewed - decimal(handover.expectedCash)); handover.reviewOperationId = operation.operationId; handover.reviewedAt = operation.occurredAt; handover.reviewedBy = context.user.id; this.#change(companyId, 'representative_handover', handover.id, 'upsert', handover); return { entityId: handover.id, handover: clone(handover) };
    }
    throw new AppError(400, 'UNSUPPORTED_OPERATION', 'عملية المندوب غير مدعومة');
  }

  #assertAssignedCustomer(companyId, representativeId, customerId) { if (!this.representativeCustomers.get(`${companyId}:${representativeId}:${customerId}`)?.active) throw new AppError(403, 'CUSTOMER_NOT_ASSIGNED', 'العميل غير مسند للمندوب'); }
  #transferRepresentativeStock(context, operation, sourceId, destinationId, lines, number, representativeId) {
    if (sourceId === destinationId) throw new AppError(400, 'SAME_TRANSFER_WAREHOUSE', 'مخزنا التحويل متطابقان'); const stored = [];
    for (const line of lines) { const qty = decimal(line.quantity, { positive: true }); const sourceKey = `${context.company.id}:${sourceId}:${line.itemId}`; const destinationKey = `${context.company.id}:${destinationId}:${line.itemId}`; const source = this.stockBalances.get(sourceKey); if (!source || decimal(source.quantity) < qty) throw new AppError(409, 'INSUFFICIENT_STOCK', 'المخزون لا يكفي للتحويل'); const cost = decimal(source.averageCost); const destination = this.stockBalances.get(destinationKey) || { companyId: context.company.id, warehouseId: destinationId, itemId: line.itemId, quantity: '0.000000', averageCost: '0.000000', version: 0 }; const oldDestQty = decimal(destination.quantity); const newDestQty = oldDestQty + qty; this.stockBalances.set(sourceKey, { ...source, quantity: decimalString(decimal(source.quantity) - qty), averageCost: decimal(source.quantity) === qty ? '0.000000' : source.averageCost, version: source.version + 1 }); this.stockBalances.set(destinationKey, { ...destination, quantity: decimalString(newDestQty), averageCost: decimalString(divide(multiply(oldDestQty, decimal(destination.averageCost)) + multiply(qty, cost), newDestQty)), version: destination.version + 1 }); stored.push({ itemId: line.itemId, quantity: decimalString(qty), unitCost: decimalString(cost) }); }
    const transfer = { id: randomUUID(), companyId: context.company.id, representativeId, sourceWarehouseId: sourceId, destinationWarehouseId: destinationId, transferNumber: number, operationId: operation.operationId, occurredAt: operation.occurredAt, createdBy: context.user.id, status: 'posted', lines: stored }; this.stockTransfers.set(transfer.id, Object.freeze(transfer)); this.#audit(context.company.id, context.user.id, 'stock.transfer.posted', 'stock_transfer', transfer.id, {}); this.#change(context.company.id, 'stock_transfer', transfer.id, 'upsert', transfer); return clone(transfer);
  }
  #recordDebt(companyId, customerId, representativeId, documentId, operation, type, amount, currency) { const row = { id: randomUUID(), companyId, customerId, representativeId, documentId, operationId: operation.operationId, movementType: type, amount: decimalString(amount), currency, occurredAt: operation.occurredAt }; this.debtMovements.set(row.id, Object.freeze(row)); }
  #recordCustody(companyId, representativeId, operation, type, amount, currency, referenceType, referenceId) { const row = { id: randomUUID(), companyId, representativeId, operationId: operation.operationId, movementType: type, amount: decimalString(amount), currency, referenceType, referenceId, occurredAt: operation.occurredAt }; this.custodyMovements.set(row.id, Object.freeze(row)); }
  #simpleJournal(context, operation, number, currency, lines) { const journal = { id: randomUUID(), companyId: context.company.id, entryNumber: number, status: 'posted', currency, description: number, occurredAt: operation.occurredAt, createdBy: context.user.id, lines: lines.filter(([,d,c]) => d || c).map(([accountCode,d,c]) => ({ accountCode, debit: decimalString(d), credit: decimalString(c) })) };const debit=journal.lines.reduce((s,x)=>s+decimal(x.debit),ZERO),credit=journal.lines.reduce((s,x)=>s+decimal(x.credit),ZERO);if(debit!==credit)throw new AppError(500,'UNBALANCED_JOURNAL','القيد غير متوازن'); this.journalEntries.set(journal.id, Object.freeze(journal));return clone(journal); }
  #employee(companyId,id){const row=this.employees.get(id);if(!row||row.companyId!==companyId)throw new AppError(404,'EMPLOYEE_NOT_FOUND','الموظف غير موجود');return row;}
  #employeeByUser(companyId,userId){return[...this.employees.values()].find(x=>x.companyId===companyId&&x.userId===userId)||null;}
  #defaultPayrollSettings(companyId){return{companyId,workingDaysPerMonth:30,dailyHours:'8.000000',defaultOvertimeMultiplier:'1.500000',deductAbsence:false,attendanceRequired:false};}
  #payrollCycle(companyId,id){const row=this.payrollCycles.get(id);if(!row||row.companyId!==companyId)throw new AppError(404,'PAYROLL_CYCLE_NOT_FOUND','دورة الرواتب غير موجودة');return row;}
  #calculatePayrollLine(companyId,employee,contract,settings,input){const base=decimal(contract.basicSalary),working=BigInt(settings.workingDaysPerMonth)*1000000n;const presentDates=new Set([...this.attendanceEvents.values()].filter(x=>x.companyId===companyId&&x.employeeId===employee.id&&x.eventType==='check_in'&&x.eventTime.slice(0,10)>=input.periodStart&&x.eventTime.slice(0,10)<=input.periodEnd).map(x=>x.eventTime.slice(0,10)));let paidLeaveDays=0;for(const leave of this.leaveRequests.values())if(leave.companyId===companyId&&leave.employeeId===employee.id&&leave.status==='approved'&&leave.paid)paidLeaveDays+=overlapDays(leave.startDate,leave.endDate,input.periodStart,input.periodEnd);const absenceDays=settings.attendanceRequired?Math.max(0,settings.workingDaysPerMonth-presentDates.size-paidLeaveDays):0;const absence=settings.deductAbsence?multiply(divide(base,working),BigInt(absenceDays)*1000000n):ZERO;const baseEarned=base-absence;const recurring=[...this.employeeComponents.values()].filter(x=>x.companyId===companyId&&x.employeeId===employee.id&&x.active);const allowances=recurring.filter(x=>x.componentType==='allowance').reduce((s,x)=>s+decimal(x.amount),ZERO);const recurringDeductions=recurring.filter(x=>x.componentType==='deduction').reduce((s,x)=>s+decimal(x.amount),ZERO);const approvedOvertime=[...this.overtimeRequests.values()].filter(x=>x.companyId===companyId&&x.employeeId===employee.id&&x.status==='approved'&&x.workDate>=input.periodStart&&x.workDate<=input.periodEnd);const overtimeMinutes=approvedOvertime.reduce((s,x)=>s+x.minutes,0);const minuteRate=divide(base,multiply(working,multiply(decimal(settings.dailyHours),decimal('60'))));const overtimeAmount=approvedOvertime.reduce((s,x)=>s+multiply(minuteRate,multiply(BigInt(x.minutes)*1000000n,decimal(x.multiplier))),ZERO);const gross=baseEarned+allowances+overtimeAmount;let advance=ZERO;const advances=[...this.employeeAdvances.values()].filter(x=>x.companyId===companyId&&x.employeeId===employee.id&&x.status==='active'&&x.currency===contract.currency);for(const item of advances){const value=decimal(item.remainingAmount)<decimal(item.installmentAmount)?decimal(item.remainingAmount):decimal(item.installmentAmount);advance+=value;}if(recurringDeductions>gross)throw new AppError(409,'DEDUCTIONS_EXCEED_GROSS','الاستقطاعات تتجاوز مستحق الموظف');if(recurringDeductions+advance>gross)advance=gross-recurringDeductions;const deductions=recurringDeductions+advance,net=gross-deductions;const components=[{type:'base',code:'BASE',name:'الراتب المستحق',amount:decimalString(baseEarned)},...recurring.map(x=>({type:x.componentType,code:x.code,name:x.name,amount:x.amount,sourceId:x.id})),...approvedOvertime.map(x=>({type:'overtime',code:'OVERTIME',name:'إضافي',amount:decimalString(multiply(minuteRate,multiply(BigInt(x.minutes)*1000000n,decimal(x.multiplier)))),sourceId:x.id})),...advances.map(x=>({type:'advance',code:'ADVANCE',name:'قسط سلفة',amount:decimalString(decimal(x.remainingAmount)<decimal(x.installmentAmount)?decimal(x.remainingAmount):decimal(x.installmentAmount)),sourceId:x.id}))];return{id:randomUUID(),companyId,employeeId:employee.id,contractId:contract.id,basicSalary:contract.basicSalary,baseEarned:decimalString(baseEarned),allowances:decimalString(allowances),overtimeAmount:decimalString(overtimeAmount),absenceDeduction:decimalString(absence),recurringDeductions:decimalString(recurringDeductions),advanceDeduction:decimalString(advance),grossAmount:decimalString(gross),totalDeductions:decimalString(deductions),netAmount:decimalString(net),attendanceDays:presentDates.size,absenceDays,overtimeMinutes,snapshot:{employeeName:employee.fullName,settings:clone(settings)},components};}
  #payrollAccrualJournal(context,cycle,operationId){const advance=cycle.lines.reduce((s,x)=>s+decimal(x.advanceDeduction),ZERO),other=cycle.lines.reduce((s,x)=>s+decimal(x.recurringDeductions),ZERO);const journal=this.#simpleJournal(context,{operationId,occurredAt:new Date().toISOString()},`PAYROLL-${cycle.cycleCode}`,cycle.currency,[['6100-PAYROLL-EXPENSE',decimal(cycle.totalGross),ZERO],['1300-EMPLOYEE-ADVANCES',ZERO,advance],['2200-PAYROLL-DEDUCTIONS',ZERO,other],['2300-PAYROLL-PAYABLE',ZERO,decimal(cycle.totalNet)]]);for(const line of cycle.lines){for(const component of line.components.filter(x=>x.type==='advance')){const item=this.employeeAdvances.get(component.sourceId);if(!item)continue;const applied=decimal(component.amount)>decimal(line.advanceDeduction)?decimal(line.advanceDeduction):decimal(component.amount);item.remainingAmount=decimalString(decimal(item.remainingAmount)-applied);if(decimal(item.remainingAmount)===ZERO)item.status='settled';}}return journal;}
  #representativeTransactionSnapshot(){return{stockBalances:structuredClone(this.stockBalances),commerceDocuments:structuredClone(this.commerceDocuments),journalEntries:structuredClone(this.journalEntries),serverOutbox:structuredClone(this.serverOutbox),changes:structuredClone(this.changes),audit:structuredClone(this.audit),stockTransfers:structuredClone(this.stockTransfers),representativeOrders:structuredClone(this.representativeOrders),debtMovements:structuredClone(this.debtMovements),representativeCollections:structuredClone(this.representativeCollections),custodyMovements:structuredClone(this.custodyMovements),representativeHandovers:structuredClone(this.representativeHandovers),changeSequence:this.changeSequence};}
  #restoreRepresentativeTransaction(s){for(const key of ['stockBalances','commerceDocuments','journalEntries','stockTransfers','representativeOrders','debtMovements','representativeCollections','custodyMovements','representativeHandovers'])this[key]=s[key];this.serverOutbox=s.serverOutbox;this.changes=s.changes;this.audit=s.audit;this.changeSequence=s.changeSequence;}

  #openPosShift(context, operation) {
    const payload = operation.payload;
    const device = this.posDevices.get(payload.deviceId);
    if (!device || device.companyId !== context.company.id || !device.active) throw new AppError(404, 'POS_DEVICE_NOT_FOUND', 'جهاز الكاشير غير موجود');
    if ([...this.posShifts.values()].some((shift) => shift.companyId === context.company.id && shift.deviceId === device.id && shift.status !== 'closed')) throw new AppError(409, 'POS_SHIFT_ALREADY_OPEN', 'يوجد شفت مفتوح للجهاز');
    const shift = {
      id: payload.shiftId, companyId: context.company.id, deviceId: device.id, openedBy: context.user.id,
      status: 'open', openingFloat: decimalString(decimal(payload.openingFloat, { nonNegative: true })),
      expectedCash: null, countedCash: null, variance: null, openedAt: operation.occurredAt,
      openOperationId: operation.operationId, interfaceMode: device.interfaceMode
    };
    this.posShifts.set(shift.id, shift);
    this.#audit(context.company.id, context.user.id, 'pos.shift.opened', 'pos_shift', shift.id, {});
    this.#change(context.company.id, 'pos_shift', shift.id, 'upsert', shift);
    return clone(shift);
  }

  #commitPosDocument(context, operation) {
    const payload = operation.payload;
    const device = this.posDevices.get(payload.deviceId);
    const shift = this.posShifts.get(payload.shiftId);
    if (!device || device.companyId !== context.company.id || !shift || shift.companyId !== context.company.id || shift.deviceId !== device.id || shift.status !== 'open') {
      throw new AppError(409, 'POS_SHIFT_NOT_OPEN', 'لا يوجد شفت مفتوح لهذا الجهاز');
    }
    if (payload.interfaceMode !== device.interfaceMode) throw new AppError(400, 'POS_INTERFACE_MISMATCH', 'واجهة البيع لا تطابق إعداد الجهاز');
    const isReturn = operation.type === 'pos.return';
    let gross = ZERO;
    if (!isReturn) {
      for (const line of payload.lines) gross += multiply(decimal(line.quantity, { positive: true }), decimal(line.unitPrice, { nonNegative: true }));
      const discount = decimal(payload.discountAmount || '0', { nonNegative: true });
      const percent = gross === ZERO ? ZERO : divide(discount, gross) * 100n;
      const policy = this.posDiscountPolicies.get(device.id) || { maxDiscountPercent: '0.000000' };
      if (percent > decimal(policy.maxDiscountPercent) && !context.permissions.includes('sales.discount.override')) throw new AppError(403, 'DISCOUNT_APPROVAL_REQUIRED', 'الخصم يتجاوز صلاحية الكاشير');
    }
    const allocations = [];
    for (const line of payload.lines) {
      const relation = [...this.itemUnits.values()].find((row) => row.companyId === context.company.id && row.itemId === line.itemId && row.unitId === line.unitId);
      if (!relation) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
      const baseQuantity = multiply(decimal(line.quantity, { positive: true }), decimal(relation.conversionFactor));
      const key = `${context.company.id}:${device.id}:${line.itemId}`;
      const allocation = this.offlineAllocations.get(key);
      if ((!allocation || (allocation.expiresAt && Date.parse(allocation.expiresAt) <= Date.now())) && payload.offlineOrigin) throw new AppError(409, 'OFFLINE_ALLOCATION_REQUIRED', 'لا يوجد مخصص صالح للمادة على الجهاز');
      if (!allocation) continue;
      if (!isReturn && decimal(allocation.allocatedQuantity) - decimal(allocation.consumedQuantity) < baseQuantity) throw new AppError(409, 'OFFLINE_ALLOCATION_EXCEEDED', 'كمية البيع تتجاوز مخصص الجهاز');
      allocations.push({ key, allocation, baseQuantity });
    }
    const commerceOperation = {
      ...operation,
      payload: {
        ...payload, documentType: isReturn ? 'sale_return' : 'sale', warehouseId: device.warehouseId,
        posShiftId: shift.id, interfaceMode: device.interfaceMode,
        orderContext: payload.orderContext || {}, discountAmount: isReturn ? '0.000000' : payload.discountAmount || '0.000000'
      }
    };
    const document = this.#commitCommerce(context, commerceOperation);
    for (const { key, allocation, baseQuantity } of allocations) {
      const consumed = decimal(allocation.consumedQuantity);
      allocation.consumedQuantity = decimalString(isReturn ? (consumed > baseQuantity ? consumed - baseQuantity : ZERO) : consumed + baseQuantity);
      allocation.version += 1;
      this.offlineAllocations.set(key, allocation);
    }
    const receipt = {
      id: randomUUID(), companyId: context.company.id, documentId: document.id, shiftId: shift.id,
      receiptNumber: `RCP-${device.code}-${operation.clientSequence}`, printCount: 0,
      payload: { company: context.company.legalName, device: device.name, document, cashier: context.user.displayName }
    };
    this.posReceipts.set(receipt.id, Object.freeze(receipt));
    this.#change(context.company.id, 'pos_receipt', receipt.id, 'upsert', receipt);
    return { document, receipt: clone(receipt) };
  }

  #closePosShift(context, operation) {
    const payload = operation.payload;
    const shift = this.posShifts.get(payload.shiftId);
    if (!shift || shift.companyId !== context.company.id || shift.deviceId !== payload.deviceId || shift.status !== 'open') throw new AppError(409, 'POS_SHIFT_NOT_OPEN', 'الشفت غير مفتوح');
    let cashSales = ZERO;
    let cashReturns = ZERO;
    for (const document of this.commerceDocuments.values()) {
      if (document.companyId !== context.company.id || document.posShiftId !== shift.id) continue;
      const cash = document.payments.filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + decimal(payment.amount), ZERO);
      if (document.documentType === 'sale') cashSales += cash;
      if (document.documentType === 'sale_return') cashReturns += cash;
    }
    const expected = decimal(shift.openingFloat) + cashSales - cashReturns;
    const counted = decimal(payload.countedCash, { nonNegative: true });
    shift.status = 'closed'; shift.expectedCash = decimalString(expected); shift.countedCash = decimalString(counted);
    shift.variance = decimalString(counted - expected); shift.closedBy = context.user.id;
    shift.closeOperationId = operation.operationId; shift.closedAt = operation.occurredAt;
    this.#audit(context.company.id, context.user.id, 'pos.shift.closed', 'pos_shift', shift.id, { variance: shift.variance });
    this.#change(context.company.id, 'pos_shift', shift.id, 'upsert', shift);
    return clone(shift);
  }

  #commitCommerce(context, operation) {
    const companyId = context.company.id;
    const payload = operation.payload;
    const assignedManager = payload.documentType==='sale'&&salesRep(context)?assignedSalesManager(this,context):null;
    const salesApproval = !payload.representativeId ? checkSales(this,context,payload) : null;
    const warehouse = this.warehouses.get(payload.warehouseId);
    if (!warehouse || warehouse.companyId !== companyId) throw new AppError(400, 'WAREHOUSE_NOT_FOUND', 'المخزن غير موجود');
    if (![ 'purchase', 'sale', 'purchase_return', 'sale_return' ].includes(payload.documentType)) throw new AppError(400, 'INVALID_DOCUMENT_TYPE', 'نوع المستند غير صالح');
    if ([...this.commerceDocuments.values()].some((row) => row.companyId === companyId && row.documentType === payload.documentType && row.documentNumber === payload.documentNumber)) {
      throw new AppError(409, 'DOCUMENT_NUMBER_EXISTS', 'رقم المستند مستخدم');
    }
    const isSale = payload.documentType.startsWith('sale');
    const isReturn = payload.documentType.endsWith('_return');
    const partyMap = isSale ? this.customers : this.suppliers;
    if (payload.partyId && (!partyMap.get(payload.partyId) || partyMap.get(payload.partyId).companyId !== companyId)) throw new AppError(400, 'PARTY_NOT_FOUND', 'العميل أو المورد غير موجود');
    const original = isReturn ? this.commerceDocuments.get(payload.originalDocumentId) : null;
    if (isReturn && [...this.financialRecords.values()].some(row => row.companyId === companyId && row.kind === 'enterprise_settlement' && row.documentId === payload.originalDocumentId)) throw new AppError(409, 'SETTLED_RETURN_REVIEW_REQUIRED', 'الفاتورة لها سندات تسوية؛ يلزم معالجة التسوية قبل المرتجع');
    const expectedOriginalType = payload.documentType === 'sale_return' ? 'sale' : 'purchase';
    if (isReturn && (!original || original.companyId !== companyId || original.documentType !== expectedOriginalType)) throw new AppError(400, 'ORIGINAL_DOCUMENT_INVALID', 'المستند الأصلي غير صالح');
    if(isReturn&&salesRep(context)&&original?.customerId&&(this.salesSettings.get('customer:'+original.customerId)?.channel||'retail')!==(this.salesSettings.get('user:'+context.user.id)?.channel||'retail'))throw new AppError(403,'CUSTOMER_SCOPE','المستند خارج نطاق زبائنك');
    if (isReturn && original.currency !== payload.currency) throw new AppError(400, 'RETURN_CURRENCY_MISMATCH', 'عملة المرتجع يجب أن تطابق المستند الأصلي');
    if (!Array.isArray(payload.lines) || !payload.lines.length) throw new AppError(400, 'DOCUMENT_LINES_REQUIRED', 'بنود المستند مطلوبة');
    if (new Set(payload.lines.map((line) => line.itemId)).size !== payload.lines.length) throw new AppError(400, 'DUPLICATE_DOCUMENT_ITEM', 'لا تكرر المادة في المستند؛ اجمع الكمية في بند واحد');

    const lines = [];
    let subtotal = ZERO;
    let inventoryCost = ZERO;
    const stockUpdates = new Map();
    for (const input of payload.lines) {
      const relation = [...this.itemUnits.values()].find((row) => row.companyId === companyId && row.itemId === input.itemId && row.unitId === input.unitId);
      if (!relation) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
      const quantity = decimal(input.quantity, { positive: true });
      const factor = decimal(relation.conversionFactor, { positive: true });
      const baseQuantity = multiply(quantity, factor);
      let unitPrice;
      let unitCost;
      let originalLine = null;
      if (isReturn) {
        originalLine = original.lines.find((line) => line.id === input.originalLineId && line.itemId === input.itemId && line.unitId === input.unitId);
        if (!originalLine) throw new AppError(400, 'ORIGINAL_LINE_INVALID', 'بند المستند الأصلي غير صالح');
        const alreadyReturned = [...this.commerceDocuments.values()].filter((doc) => doc.companyId === companyId && doc.documentType === payload.documentType && doc.originalDocumentId === original.id)
          .flatMap((doc) => doc.lines).filter((line) => line.originalLineId === originalLine.id)
          .reduce((sum, line) => sum + decimal(line.baseQuantity), ZERO);
        if (alreadyReturned + baseQuantity > decimal(originalLine.baseQuantity)) throw new AppError(409, 'RETURN_QUANTITY_EXCEEDED', 'كمية المرتجع تتجاوز الأصل');
        unitPrice = decimal(originalLine.unitPrice, { nonNegative: true });
        if (decimal(original.grossAmount || original.subtotal) > ZERO && decimal(original.discountAmount || '0') > ZERO) {
          unitPrice = multiply(unitPrice, divide(decimal(original.subtotal), decimal(original.grossAmount)));
        }
        unitCost = decimal(originalLine.unitCost, { nonNegative: true });
      } else {
        unitPrice = decimal(input.unitPrice, { nonNegative: true });
      }
      const lineTotal = multiply(quantity, unitPrice);
      subtotal += lineTotal;
      const stockKey = `${companyId}:${warehouse.id}:${input.itemId}`;
      const current = stockUpdates.get(stockKey) || this.stockBalances.get(stockKey) || { companyId, warehouseId: warehouse.id, itemId: input.itemId, quantity: '0.000000', averageCost: '0.000000', version: 0 };
      const oldQty = decimal(current.quantity);
      const oldCost = decimal(current.averageCost, { nonNegative: true });
      let newQty;
      let newCost = oldCost;
      if (payload.documentType === 'purchase' || payload.documentType === 'sale_return') {
        newQty = oldQty + baseQuantity;
        const receivedUnitCost = payload.documentType === 'purchase' ? divide(lineTotal, baseQuantity) : unitCost;
        newCost = newQty === ZERO ? ZERO : divide(multiply(oldQty, oldCost) + multiply(baseQuantity, receivedUnitCost), newQty);
        unitCost = receivedUnitCost;
      } else {
        const reservedOther = [...this.offlineAllocations.values()]
          .filter((row) => row.companyId === companyId && row.warehouseId === warehouse.id && row.itemId === input.itemId && row.deviceId !== payload.deviceId)
          .reduce((sum, row) => sum + decimal(row.allocatedQuantity) - decimal(row.consumedQuantity), ZERO);
        if (oldQty - reservedOther < baseQuantity) {
          if (oldQty < baseQuantity) throw new AppError(409, 'INSUFFICIENT_STOCK', 'المخزون غير كافٍ');
          throw new AppError(409, 'STOCK_RESERVED_FOR_OFFLINE', 'الكمية المتاحة محجوزة لأجهزة أوف لاين');
        }
        newQty = oldQty - baseQuantity;
        unitCost = isReturn ? unitCost : oldCost;
        if (newQty === ZERO) newCost = ZERO;
      }
      const costTotal = multiply(baseQuantity, unitCost);
      inventoryCost += costTotal;
      stockUpdates.set(stockKey, { ...current, quantity: decimalString(newQty), averageCost: decimalString(newCost), version: current.version + 1 });
      lines.push({ id: randomUUID(), itemId: input.itemId, unitId: input.unitId, originalLineId: originalLine?.id || null, quantity: decimalString(quantity), conversionFactor: decimalString(factor), baseQuantity: decimalString(baseQuantity), unitPrice: decimalString(unitPrice), lineTotal: decimalString(lineTotal), unitCost: decimalString(unitCost), specifications: clone(input.specifications || {}), note: String(input.note || '') });
    }
    const gross = subtotal;
    const discount = decimal(payload.discountAmount || '0', { nonNegative: true });
    if (discount > gross) throw new AppError(400, 'DISCOUNT_EXCEEDS_TOTAL', 'الخصم يتجاوز إجمالي المستند');
    subtotal = gross - discount;
    const payments = payload.payments || [];
    const paid = payments.reduce((sum, payment) => sum + decimal(payment.amount, { positive: true }), ZERO);
    if (paid > subtotal) throw new AppError(400, 'PAYMENTS_EXCEED_TOTAL', 'الدفعات تتجاوز قيمة المستند');
    if (isSale && subtotal > paid && !payload.partyId) throw new AppError(400, 'CUSTOMER_REQUIRED_FOR_CREDIT', 'العميل مطلوب للبيع الآجل أو المختلط');
    const document = {
      id: randomUUID(), companyId, documentType: payload.documentType, documentNumber: payload.documentNumber,
      warehouseId: warehouse.id, customerId: isSale ? payload.partyId || null : null,
      supplierId: isSale ? null : payload.partyId || null, originalDocumentId: original?.id || null,
      currency: payload.currency, subtotal: decimalString(subtotal), paidAmount: decimalString(paid), dueAmount: decimalString(subtotal - paid),
      grossAmount: decimalString(gross), discountAmount: decimalString(discount), posShiftId: payload.posShiftId || null,
      interfaceMode: payload.interfaceMode || null, orderContext: clone(payload.orderContext || {}), note: String(payload.note || ''),
      assignedSalesManagerId: assignedManager, representativeId: payload.representativeId || null, delivery: clone(payload.delivery || {}), salesChannel: salesRep(context) ? (this.salesSettings.get('user:'+context.user.id)?.channel || 'retail') : null, approvalId: salesApproval?.id || null,
      operationId: operation.operationId, occurredAt: operation.occurredAt, createdBy: context.user.id, status: 'posted', lines,
      payments: payments.map((payment) => ({ id: randomUUID(), method: payment.method, amount: decimalString(decimal(payment.amount)), reference: payment.reference || null }))
    };
    const journal = this.#commerceJournal(document, inventoryCost);
    for (const [key, balance] of stockUpdates) this.stockBalances.set(key, Object.freeze(balance));
    if (salesApproval) {
      this.salesApprovals.set(salesApproval.id,{...salesApproval,status:'used',documentId:document.id});
      for (const line of document.lines) { const key='item:'+line.itemId,cfg=this.salesSettings.get(key);if(cfg?.reserved?.[warehouse.id]){const qty=decimal(stockUpdates.get(companyId+':'+warehouse.id+':'+line.itemId)?.quantity||'0');const remaining=decimal(cfg.reserved[warehouse.id]);this.salesSettings.set(key,{...cfg,reserved:{...cfg.reserved,[warehouse.id]:decimalString(qty<remaining?qty:remaining)}});} }
    }
    this.commerceDocuments.set(document.id, Object.freeze(document));
    this.journalEntries.set(journal.id, Object.freeze(journal));
    if (isSale && document.customerId && decimal(document.dueAmount) > ZERO) this.#recordDebt(companyId, document.customerId, document.representativeId, document.id, operation, isReturn ? 'sale_return' : 'sale', isReturn ? -decimal(document.dueAmount) : decimal(document.dueAmount), document.currency);
    if (document.representativeId && decimal(document.paidAmount) > ZERO) this.#recordCustody(companyId, document.representativeId, operation, isReturn ? 'return_cash' : 'sale_cash', isReturn ? -decimal(document.paidAmount) : decimal(document.paidAmount), document.currency, 'commerce_document', document.id);
    this.serverOutbox.push(Object.freeze({ id: randomUUID(), companyId, eventType: 'commerce.document.posted', aggregateId: document.id, payload: { documentType: document.documentType, total: document.subtotal } }));
    this.#audit(companyId, context.user.id, 'commerce.document.posted', 'commerce_document', document.id, { documentType: document.documentType });
    this.#change(companyId, 'commerce_document', document.id, 'upsert', document);
    for (const balance of stockUpdates.values()) this.#change(companyId, 'stock_balance', balance.itemId, 'upsert', balance);
    return clone(document);
  }

  #commerceJournal(document, inventoryCost) {
    const total = decimal(document.subtotal);
    const paid = decimal(document.paidAmount);
    const due = total - paid;
    const lines = [];
    const add = (account, debit, credit) => { if (debit || credit) lines.push({ account, debit: decimalString(debit), credit: decimalString(credit) }); };
    const cashAccount = document.representativeId ? '1150-REP-CASH-CUSTODY' : '1000-CASH';
    if (document.documentType === 'purchase') {
      add('1200-INVENTORY', total, ZERO); add('1000-CASH', ZERO, paid); add('2100-AP', ZERO, due);
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

