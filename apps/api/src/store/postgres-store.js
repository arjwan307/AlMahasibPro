import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AppError } from '../lib/http.js';
import { decimal, decimalString, divide, multiply, ZERO } from '../lib/decimal.js';
import { PERMISSIONS, ROLE_TEMPLATES } from '../permissions.js';

export class PostgresStore {
  constructor(connectionString, options = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max || 10 });
  }

  async close() { await this.pool.end(); }

  async seedPlatformAdmin({ username, passwordHash, displayName = 'Platform Admin' }) {
    return this.#transaction({ platform: true }, async (client) => {
      const result = await client.query(
        `INSERT INTO users (username, display_name, password_hash, status, platform_admin)
         VALUES ($1, $2, $3, 'active', true)
         ON CONFLICT (username) WHERE platform_admin DO UPDATE
           SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash, status = 'active'
         RETURNING *`, [username, displayName, passwordHash]
      );
      return mapUser(result.rows[0], true);
    });
  }

  async registerCompany({ code, legalName, timezone, currency, owner }) {
    try {
      return await this.#transaction({ platform: true }, async (client) => {
        const companyResult = await client.query(
          `INSERT INTO companies (code, legal_name, timezone, currency)
           VALUES ($1, $2, $3, $4) RETURNING *`, [code, legalName, timezone, currency]
        );
        const company = companyResult.rows[0];
        await client.query(`SELECT set_config('app.company_id', $1, true)`, [company.id]);
        await client.query(`INSERT INTO branches (company_id, code, name) VALUES ($1, 'main', 'الفرع الرئيسي')`, [company.id]);
        for (const permission of PERMISSIONS) {
          await client.query(`INSERT INTO permissions (code) VALUES ($1) ON CONFLICT DO NOTHING`, [permission]);
        }
        let adminRoleId;
        for (const [roleCode, permissions] of Object.entries(ROLE_TEMPLATES)) {
          const roleResult = await client.query(
            `INSERT INTO roles (company_id, code, name, system) VALUES ($1, $2::text, $2::text, true) RETURNING id`,
            [company.id, roleCode]
          );
          if (roleCode === 'company_admin') adminRoleId = roleResult.rows[0].id;
          for (const permission of permissions) {
            await client.query(
              `INSERT INTO role_permissions (company_id, role_id, permission_code) VALUES ($1, $2, $3)`,
              [company.id, roleResult.rows[0].id, permission]
            );
          }
        }
        const userResult = await client.query(
          `INSERT INTO users (company_id, username, display_name, password_hash, status)
           VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
          [company.id, owner.username, owner.displayName, owner.passwordHash]
        );
        const userId = userResult.rows[0].id;
        await client.query(`INSERT INTO user_roles (company_id, user_id, role_id) VALUES ($1, $2, $3)`, [company.id, userId, adminRoleId]);
        await client.query(
          `INSERT INTO user_scopes (company_id, user_id, scope_type, scope_id) VALUES ($1, $2, 'company', $1)`,
          [company.id, userId]
        );
        const updated = await client.query(`UPDATE companies SET owner_user_id = $2 WHERE id = $1 RETURNING *`, [company.id, userId]);
        await this.#audit(client, company.id, null, 'company.registered', 'company', company.id, { code });
        return mapCompany(updated.rows[0]);
      });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'COMPANY_CODE_EXISTS', 'رمز الشركة مستخدم');
      throw error;
    }
  }

  async listPendingCompanies() {
    const result = await this.pool.query(`SELECT * FROM companies WHERE status = 'pending' ORDER BY created_at`);
    return result.rows.map(mapCompany);
  }

  async approveCompany(companyId, actorUserId) {
    return this.#transaction({ platform: true }, async (client) => {
      const result = await client.query(
        `UPDATE companies SET status = 'active', approved_at = COALESCE(approved_at, now()),
           approved_by = COALESCE(approved_by, $2), updated_at = now()
         WHERE id = $1 RETURNING *`, [companyId, actorUserId]
      );
      if (!result.rowCount) throw new AppError(404, 'COMPANY_NOT_FOUND', 'الشركة غير موجودة');
      await client.query(`UPDATE users SET status = 'active', updated_at = now() WHERE company_id = $1 AND status = 'pending'`, [companyId]);
      await this.#audit(client, companyId, actorUserId, 'company.approved', 'company', companyId, {});
      await this.#change(client, companyId, 'company', companyId, 'upsert', mapCompany(result.rows[0]));
      return mapCompany(result.rows[0]);
    });
  }

  async findLogin({ companyCode, username, platform }) {
    if (platform) {
      return this.#transaction({ platform: true }, async (client) => {
        const result = await client.query(`SELECT * FROM users WHERE platform_admin AND username = $1`, [username]);
        return result.rowCount ? { user: mapUser(result.rows[0], true), company: null } : null;
      });
    }
    const companyResult = await this.pool.query(`SELECT * FROM companies WHERE code = $1`, [companyCode]);
    if (!companyResult.rowCount) return null;
    const company = companyResult.rows[0];
    return this.#transaction({ companyId: company.id }, async (client) => {
      const result = await client.query(`SELECT * FROM users WHERE company_id = $1 AND username = $2`, [company.id, username]);
      return result.rowCount ? { user: mapUser(result.rows[0], true), company: mapCompany(company) } : null;
    });
  }

  async createSession({ tokenHash, userId, deviceId, expiresAt }) {
    return this.#transaction({ platform: true }, async (client) => {
      const user = await client.query(`SELECT company_id FROM users WHERE id = $1`, [userId]);
      const result = await client.query(
        `INSERT INTO sessions (company_id, user_id, token_hash, device_id, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [user.rows[0]?.company_id ?? null, userId, tokenHash, deviceId, expiresAt]
      );
      return mapSession(result.rows[0]);
    });
  }

  async getSessionContext(tokenHash) {
    return this.#transaction({ platform: true }, async (client) => {
      const sessionResult = await client.query(
        `SELECT s.*, u.company_id, u.username, u.display_name, u.status AS user_status, u.platform_admin
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [tokenHash]
      );
      if (!sessionResult.rowCount || sessionResult.rows[0].user_status !== 'active') return null;
      const row = sessionResult.rows[0];
      if (row.company_id) await client.query(`SELECT set_config('app.company_id', $1, true)`, [row.company_id]);
      const companyResult = row.company_id
        ? await client.query(`SELECT * FROM companies WHERE id = $1 AND status = 'active'`, [row.company_id])
        : { rows: [] };
      if (row.company_id && !companyResult.rows.length) return null;
      const rolesResult = row.company_id ? await client.query(
        `SELECT r.*, COALESCE(json_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '[]') AS permissions
         FROM roles r JOIN user_roles ur ON ur.role_id = r.id AND ur.company_id = r.company_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.company_id = r.company_id
         WHERE ur.company_id = $1 AND ur.user_id = $2 GROUP BY r.id`, [row.company_id, row.user_id]
      ) : { rows: [] };
      const scopesResult = row.company_id ? await client.query(
        `SELECT scope_type AS type, scope_id AS id FROM user_scopes WHERE company_id = $1 AND user_id = $2`,
        [row.company_id, row.user_id]
      ) : { rows: [] };
      const roles = rolesResult.rows.map((role) => ({
        id: role.id, companyId: role.company_id, code: role.code, name: role.name,
        system: role.system, permissions: role.permissions
      }));
      return {
        session: mapSession(row),
        user: { id: row.user_id, companyId: row.company_id, username: row.username, displayName: row.display_name, status: row.user_status, platformAdmin: row.platform_admin },
        company: companyResult.rows[0] ? mapCompany(companyResult.rows[0]) : null,
        roles, permissions: row.platform_admin ? ['company.approve'] : [...new Set(roles.flatMap((role) => role.permissions))],
        scopes: scopesResult.rows
      };
    });
  }

  async revokeSession(tokenHash) {
    await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
  }

  async listRoles(companyId) {
    return this.#transaction({ companyId }, async (client) => {
      const result = await client.query(
        `SELECT r.*, COALESCE(json_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '[]') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.company_id = r.company_id AND rp.role_id = r.id
         WHERE r.company_id = $1 GROUP BY r.id ORDER BY r.code`, [companyId]
      );
      return result.rows.map((role) => ({ id: role.id, companyId, code: role.code, name: role.name, system: role.system, permissions: role.permissions }));
    });
  }

  async createUser(companyId, input, actorUserId) {
    try {
      return await this.#transaction({ companyId }, async (client) => {
        const role = await client.query(`SELECT id FROM roles WHERE company_id = $1 AND code = $2`, [companyId, input.roleCode]);
        if (!role.rowCount) throw new AppError(400, 'ROLE_NOT_FOUND', 'الدور غير موجود');
        const result = await client.query(
          `INSERT INTO users (company_id, username, display_name, password_hash, status)
           VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
          [companyId, input.username, input.displayName, input.passwordHash]
        );
        const user = result.rows[0];
        await client.query(`INSERT INTO user_roles (company_id, user_id, role_id) VALUES ($1, $2, $3)`, [companyId, user.id, role.rows[0].id]);
        for (const scope of input.scopes || [{ type: 'company', id: companyId }]) {
          await client.query(
            `INSERT INTO user_scopes (company_id, user_id, scope_type, scope_id) VALUES ($1, $2, $3, $4)`,
            [companyId, user.id, scope.type, scope.id]
          );
        }
        await this.#audit(client, companyId, actorUserId, 'user.created', 'user', user.id, { roleCode: input.roleCode });
        await this.#change(client, companyId, 'user', user.id, 'upsert', mapUser(user));
        return mapUser(user);
      });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'USERNAME_EXISTS', 'اسم المستخدم مستخدم في الشركة');
      throw error;
    }
  }

  async createUnit(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'UNIT_CODE_EXISTS', async (client) => {
      const result = await client.query(
        `INSERT INTO units(company_id, code, name, decimal_places) VALUES ($1,$2,$3,$4) RETURNING *`,
        [companyId, input.code, input.name, input.decimalPlaces ?? 3]
      );
      await this.#audit(client, companyId, actorUserId, 'unit.created', 'unit', result.rows[0].id, {});
      await this.#change(client, companyId, 'unit', result.rows[0].id, 'upsert', result.rows[0]);
      return mapUnit(result.rows[0]);
    });
  }

  async createItem(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'ITEM_SKU_EXISTS', async (client) => {
      const item = await client.query(
        `INSERT INTO items(company_id, sku, name, base_unit_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [companyId, input.sku, input.name, input.baseUnitId]
      );
      const relation = await client.query(
        `INSERT INTO item_units(company_id, item_id, unit_id, conversion_factor, is_base)
         VALUES ($1,$2,$3,1,true) RETURNING *`, [companyId, item.rows[0].id, input.baseUnitId]
      );
      await this.#audit(client, companyId, actorUserId, 'item.created', 'item', item.rows[0].id, {});
      await this.#change(client, companyId, 'item', item.rows[0].id, 'upsert', item.rows[0]);
      return { ...mapItem(item.rows[0]), units: [mapItemUnit(relation.rows[0])] };
    });
  }

  async addItemUnit(companyId, itemId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'ITEM_UNIT_EXISTS', async (client) => {
      const result = await client.query(
        `INSERT INTO item_units(company_id, item_id, unit_id, conversion_factor)
         VALUES ($1,$2,$3,$4) RETURNING *`, [companyId, itemId, input.unitId, input.conversionFactor]
      );
      await this.#audit(client, companyId, actorUserId, 'item_unit.created', 'item_unit', result.rows[0].id, {});
      await this.#change(client, companyId, 'item_unit', result.rows[0].id, 'upsert', result.rows[0]);
      return mapItemUnit(result.rows[0]);
    });
  }

  async setPrice(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'PRICE_EXISTS', async (client) => {
      const relation = await client.query(
        `SELECT 1 FROM item_units WHERE company_id=$1 AND item_id=$2 AND unit_id=$3`,
        [companyId, input.itemId, input.unitId]
      );
      if (!relation.rowCount) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
      const result = await client.query(
        `INSERT INTO prices(company_id,item_id,unit_id,price_type,currency,amount)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [companyId, input.itemId, input.unitId, input.priceType, input.currency, input.amount]
      );
      await this.#audit(client, companyId, actorUserId, 'price.created', 'price', result.rows[0].id, {});
      await this.#change(client, companyId, 'price', result.rows[0].id, 'upsert', result.rows[0]);
      return mapPrice(result.rows[0]);
    });
  }

  async createParty(companyId, type, input, actorUserId) {
    const table = type === 'customer' ? 'customers' : 'suppliers';
    return this.#tenantWrite(companyId, `${type.toUpperCase()}_CODE_EXISTS`, async (client) => {
      const result = type === 'customer'
        ? await client.query(
          `INSERT INTO customers(company_id,code,name,phone,credit_limit,province,district,address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [companyId, input.code, input.name, input.phone || null, input.creditLimit || '0', input.province || null, input.district || null, input.address || null]
        )
        : await client.query(
          `INSERT INTO suppliers(company_id,code,name,phone) VALUES ($1,$2,$3,$4) RETURNING *`,
          [companyId, input.code, input.name, input.phone || null]
        );
      await this.#audit(client, companyId, actorUserId, `${type}.created`, type, result.rows[0].id, {});
      await this.#change(client, companyId, type, result.rows[0].id, 'upsert', result.rows[0]);
      return mapParty(result.rows[0], type);
    });
  }

  async createWarehouse(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'WAREHOUSE_CODE_EXISTS', async (client) => {
      const result = await client.query(
        `INSERT INTO warehouses(company_id,branch_id,code,name,kind) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [companyId, input.branchId || null, input.code, input.name, input.kind || 'standard']
      );
      await this.#audit(client, companyId, actorUserId, 'warehouse.created', 'warehouse', result.rows[0].id, {});
      await this.#change(client, companyId, 'warehouse', result.rows[0].id, 'upsert', result.rows[0]);
      return mapWarehouse(result.rows[0]);
    });
  }

  async listMasterData(companyId) {
    return this.#transaction({ companyId }, async (client) => {
      const units = await client.query(`SELECT * FROM units WHERE company_id=$1 ORDER BY code`, [companyId]);
      const items = await client.query(`SELECT * FROM items WHERE company_id=$1 ORDER BY sku`, [companyId]);
      const itemUnits = await client.query(`SELECT * FROM item_units WHERE company_id=$1`, [companyId]);
      const prices = await client.query(`SELECT * FROM prices WHERE company_id=$1 AND active ORDER BY valid_from DESC`, [companyId]);
      const customers = await client.query(`SELECT * FROM customers WHERE company_id=$1 ORDER BY code`, [companyId]);
      const suppliers = await client.query(`SELECT * FROM suppliers WHERE company_id=$1 ORDER BY code`, [companyId]);
      const warehouses = await client.query(`SELECT * FROM warehouses WHERE company_id=$1 ORDER BY code`, [companyId]);
      const stock = await client.query(`SELECT * FROM stock_balances WHERE company_id=$1 ORDER BY warehouse_id,item_id`, [companyId]);
      return {
        units: units.rows.map(mapUnit),
        items: items.rows.map((item) => ({ ...mapItem(item), units: itemUnits.rows.filter((row) => row.item_id === item.id).map(mapItemUnit) })),
        prices: prices.rows.map(mapPrice), customers: customers.rows.map((row) => mapParty(row, 'customer')),
        suppliers: suppliers.rows.map((row) => mapParty(row, 'supplier')), warehouses: warehouses.rows.map(mapWarehouse),
        stock: stock.rows.map(mapStock)
      };
    });
  }

  async listCommerceDocuments(companyId) {
    return this.#transaction({ companyId }, async (client) => {
      const documents = await client.query(
        `SELECT * FROM commerce_documents WHERE company_id=$1 ORDER BY occurred_at DESC, created_at DESC LIMIT 200`, [companyId]
      );
      const result = [];
      for (const document of documents.rows) {
        const lines = await client.query(`SELECT * FROM commerce_document_lines WHERE company_id=$1 AND document_id=$2 ORDER BY created_at`, [companyId, document.id]);
        const payments = await client.query(`SELECT id,method,amount,reference FROM payments WHERE company_id=$1 AND document_id=$2 ORDER BY created_at`, [companyId, document.id]);
        result.push({
          ...mapDocument(document), lines: lines.rows.map(mapDocumentLine),
          payments: payments.rows.map((payment) => ({ id: payment.id, method: payment.method, amount: decimalString(decimal(payment.amount)), reference: payment.reference }))
        });
      }
      return result;
    });
  }

  async listCustomerAccountSummaries(companyId) {
    return this.#transaction({ companyId }, async (client) => {
      const result = await client.query(`
        SELECT c.id AS customer_id,
          COALESCE(SUM(m.amount),0)::numeric(20,6) AS outstanding,
          MAX(m.occurred_at) AS last_movement_at,
          COALESCE(SUM(CASE WHEN m.movement_type='collection' THEN -m.amount ELSE 0 END),0)::numeric(20,6) AS collected_total,
          MAX(m.occurred_at) FILTER (WHERE m.movement_type='collection') AS last_collection_at,
          MAX(-m.amount) FILTER (WHERE m.movement_type='collection') AS last_collection_amount
        FROM customers c LEFT JOIN customer_debt_movements m
          ON m.company_id=c.company_id AND m.customer_id=c.id
          AND m.currency=(SELECT currency FROM companies WHERE id=$1)
        WHERE c.company_id=$1 GROUP BY c.id`, [companyId]);
      const docs = await client.query(`
        SELECT customer_id, COALESCE(SUM(paid_amount),0)::numeric(20,6) AS paid_total,
          MAX(occurred_at) FILTER (WHERE paid_amount>0) AS last_payment_at,
          MAX(paid_amount) FILTER (WHERE paid_amount>0) AS last_payment_amount,
          MAX(occurred_at) AS last_movement_at
        FROM commerce_documents WHERE company_id=$1 AND customer_id IS NOT NULL
          AND currency=(SELECT currency FROM companies WHERE id=$1)
        GROUP BY customer_id`, [companyId]);
      const accounts = {};
      for (const row of result.rows) accounts[row.customer_id] = {
        outstanding: decimalString(decimal(row.outstanding)), paidTotal: decimalString(decimal(row.collected_total)),
        lastMovementAt: row.last_movement_at, lastPaymentAt: row.last_collection_at,
        lastPaymentAmount: row.last_collection_amount == null ? '0.000000' : decimalString(decimal(row.last_collection_amount))
      };
      for (const row of docs.rows) {
        const account = accounts[row.customer_id]; if (!account) continue;
        account.paidTotal = decimalString(decimal(account.paidTotal) + decimal(row.paid_total || '0'));
        if (row.last_payment_at && (!account.lastPaymentAt || new Date(row.last_payment_at) > new Date(account.lastPaymentAt))) {
          account.lastPaymentAt = row.last_payment_at;
          account.lastPaymentAmount = decimalString(decimal(row.last_payment_amount || '0'));
        }
        if (row.last_movement_at && (!account.lastMovementAt || new Date(row.last_movement_at) > new Date(account.lastMovementAt))) account.lastMovementAt = row.last_movement_at;
      }
      for (const account of Object.values(accounts)) account.currency = 'IQD';
      return accounts;
    });
  }

  async setBarcode(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'BARCODE_EXISTS', async (client) => {
      const relation = await client.query(`SELECT 1 FROM item_units WHERE company_id=$1 AND item_id=$2 AND unit_id=$3`, [companyId, input.itemId, input.unitId]);
      if (!relation.rowCount) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
      const result = await client.query(
        `INSERT INTO item_barcodes(company_id,item_id,unit_id,barcode) VALUES ($1,$2,$3,$4) RETURNING *`,
        [companyId, input.itemId, input.unitId, input.barcode]
      );
      await this.#audit(client, companyId, actorUserId, 'barcode.created', 'item_barcode', result.rows[0].id, {});
      await this.#change(client, companyId, 'item_barcode', result.rows[0].id, 'upsert', result.rows[0]);
      return mapBarcode(result.rows[0]);
    });
  }

  async createPosDevice(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'POS_DEVICE_EXISTS', async (client) => {
      const result = await client.query(
        `INSERT INTO pos_devices(id,company_id,branch_id,warehouse_id,code,name,interface_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.id, companyId, input.branchId || null, input.warehouseId, input.code, input.name, input.interfaceMode]
      );
      await client.query(
        `INSERT INTO pos_discount_policies(company_id,device_id,max_discount_percent) VALUES ($1,$2,$3)`,
        [companyId, input.id, input.maxDiscountPercent || '0.000000']
      );
      await this.#audit(client, companyId, actorUserId, 'pos.device.created', 'pos_device', input.id, {});
      await this.#change(client, companyId, 'pos_device', input.id, 'upsert', result.rows[0]);
      return mapPosDevice(result.rows[0]);
    });
  }

  async setPosAllocation(companyId, deviceId, input, actorUserId) {
    return this.#transaction({ companyId }, async (client) => {
      const device = await client.query(`SELECT * FROM pos_devices WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [companyId, deviceId]);
      if (!device.rowCount) throw new AppError(404, 'POS_DEVICE_NOT_FOUND', 'جهاز الكاشير غير موجود');
      const balance = await client.query(
        `SELECT * FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 FOR UPDATE`,
        [companyId, device.rows[0].warehouse_id, input.itemId]
      );
      const reserved = await client.query(
        `SELECT COALESCE(sum(allocated_quantity-consumed_quantity),0) AS quantity FROM offline_allocations
         WHERE company_id=$1 AND item_id=$2 AND device_id<>$3`, [companyId, input.itemId, deviceId]
      );
      if (!balance.rowCount || decimal(balance.rows[0].quantity) - decimal(reserved.rows[0].quantity) < decimal(input.quantity)) {
        throw new AppError(409, 'ALLOCATION_EXCEEDS_STOCK', 'المخصص يتجاوز المخزون المتاح');
      }
      const existing = await client.query(
        `SELECT * FROM offline_allocations WHERE company_id=$1 AND device_id=$2 AND item_id=$3 FOR UPDATE`,
        [companyId, deviceId, input.itemId]
      );
      if (existing.rowCount && decimal(existing.rows[0].consumed_quantity) > decimal(input.quantity)) throw new AppError(409, 'ALLOCATION_BELOW_CONSUMED', 'لا يمكن خفض المخصص دون المستهلك');
      const result = await client.query(
        `INSERT INTO offline_allocations(company_id,device_id,warehouse_id,item_id,allocated_quantity,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id,device_id,item_id) DO UPDATE SET allocated_quantity=EXCLUDED.allocated_quantity,
           expires_at=EXCLUDED.expires_at,version=offline_allocations.version+1,updated_at=now()
         RETURNING *`, [companyId, deviceId, device.rows[0].warehouse_id, input.itemId, input.quantity, input.expiresAt || null]
      );
      await this.#audit(client, companyId, actorUserId, 'pos.allocation.updated', 'offline_allocation', input.itemId, { deviceId });
      await this.#change(client, companyId, 'offline_allocation', input.itemId, 'upsert', result.rows[0]);
      return mapAllocation(result.rows[0]);
    });
  }

  async getPosBootstrap(companyId, deviceId) {
    return this.#transaction({ companyId }, async (client) => {
      const device = await client.query(`SELECT * FROM pos_devices WHERE company_id=$1 AND id=$2 AND active`, [companyId, deviceId]);
      if (!device.rowCount) throw new AppError(404, 'POS_DEVICE_NOT_FOUND', 'جهاز الكاشير غير موجود');
      const shift = await client.query(`SELECT * FROM pos_shifts WHERE company_id=$1 AND device_id=$2 AND status<>'closed'`, [companyId, deviceId]);
      const allocations = await client.query(`SELECT * FROM offline_allocations WHERE company_id=$1 AND device_id=$2`, [companyId, deviceId]);
      const barcodes = await client.query(
        `SELECT b.*,i.sku,i.name AS item_name,iu.conversion_factor,pr.amount AS sale_price,pr.currency
         FROM item_barcodes b JOIN items i ON i.company_id=b.company_id AND i.id=b.item_id
         JOIN item_units iu ON iu.company_id=b.company_id AND iu.item_id=b.item_id AND iu.unit_id=b.unit_id
         LEFT JOIN LATERAL (SELECT amount,currency FROM prices p WHERE p.company_id=b.company_id AND p.item_id=b.item_id
           AND p.unit_id=b.unit_id AND p.price_type='sale' AND p.active AND p.valid_from<=now()
           AND (p.valid_to IS NULL OR p.valid_to>now()) ORDER BY p.valid_from DESC LIMIT 1) pr ON true
         WHERE b.company_id=$1`, [companyId]
      );
      const policy = await client.query(
        `SELECT * FROM pos_discount_policies WHERE company_id=$1 AND (device_id=$2 OR device_id IS NULL)
         ORDER BY device_id NULLS LAST LIMIT 1`, [companyId, deviceId]
      );
      const customers = await client.query(`SELECT * FROM customers WHERE company_id=$1 AND active ORDER BY code`, [companyId]);
      return {
        device: mapPosDevice(device.rows[0]), shift: shift.rowCount ? mapPosShift(shift.rows[0]) : null,
        allocations: allocations.rows.map(mapAllocation), barcodes: barcodes.rows.map(mapPosBarcode),
        customers: customers.rows.map((row) => mapParty(row, 'customer')),
        discountPolicy: policy.rowCount ? mapDiscountPolicy(policy.rows[0]) : { maxDiscountPercent: '0.000000' }
      };
    });
  }

  async createRepresentative(companyId, input, actorUserId) {
    return this.#tenantWrite(companyId, 'REPRESENTATIVE_EXISTS', async (client) => {
      const result = await client.query(`INSERT INTO representatives(company_id,user_id,vehicle_warehouse_id,code,name,device_id) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM warehouses WHERE company_id=$1 AND id=$3 AND kind='vehicle') RETURNING *`, [companyId,input.userId,input.vehicleWarehouseId,input.code,input.name,input.deviceId]);
      if (!result.rowCount) throw new AppError(400,'VEHICLE_WAREHOUSE_REQUIRED','يجب تحديد مخزن سيارة من الشركة');
      await this.#audit(client,companyId,actorUserId,'representative.created','representative',result.rows[0].id,{}); await this.#change(client,companyId,'representative',result.rows[0].id,'upsert',mapRepresentative(result.rows[0])); return mapRepresentative(result.rows[0]);
    });
  }

  async assignRepresentativeCustomer(companyId, representativeId, input, actorUserId) {
    return this.#tenantWrite(companyId,'REPRESENTATIVE_CUSTOMER_INVALID',async(client)=>{ const result=await client.query(`INSERT INTO representative_customers(company_id,representative_id,customer_id,visit_order,credit_limit) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,representative_id,customer_id) DO UPDATE SET visit_order=EXCLUDED.visit_order,credit_limit=EXCLUDED.credit_limit,active=true RETURNING *`,[companyId,representativeId,input.customerId,input.visitOrder,input.creditLimit]); await this.#audit(client,companyId,actorUserId,'representative.customer.assigned','representative_customer',input.customerId,{representativeId}); return mapRepresentativeCustomer(result.rows[0]); });
  }

  async createRepresentativeRoute(companyId, representativeId, input, actorUserId) {
    return this.#tenantWrite(companyId,'ROUTE_CODE_EXISTS',async(client)=>{ const assigned=await client.query(`SELECT customer_id FROM representative_customers WHERE company_id=$1 AND representative_id=$2 AND active AND customer_id=ANY($3::uuid[])`,[companyId,representativeId,input.stops.map(s=>s.customerId)]); if(assigned.rowCount!==new Set(input.stops.map(s=>s.customerId)).size) throw new AppError(400,'CUSTOMER_NOT_ASSIGNED','أحد العملاء غير مسند للمندوب'); const route=await client.query(`INSERT INTO representative_routes(company_id,representative_id,code,name,route_date) VALUES($1,$2,$3,$4,$5) RETURNING *`,[companyId,representativeId,input.code,input.name,input.routeDate]); for(const stop of input.stops) await client.query(`INSERT INTO representative_route_stops(company_id,route_id,customer_id,stop_order,note) VALUES($1,$2,$3,$4,$5)`,[companyId,route.rows[0].id,stop.customerId,stop.stopOrder,stop.note]); const value={...mapRepresentativeRoute(route.rows[0]),stops:input.stops}; await this.#audit(client,companyId,actorUserId,'representative.route.created','representative_route',route.rows[0].id,{}); await this.#change(client,companyId,'representative_route',route.rows[0].id,'upsert',value); return value; });
  }

  async getRepresentativeBootstrap(context, representativeId=null) {
    const companyId=context.company.id; return this.#transaction({companyId},async(client)=>{ const rep=await client.query(`SELECT * FROM representatives WHERE company_id=$1 AND active AND ${representativeId?'id=$2':'user_id=$2'}`,[companyId,representativeId||context.user.id]); if(!rep.rowCount || (!context.permissions.includes('representatives.manage')&&rep.rows[0].user_id!==context.user.id)) throw new AppError(404,'REPRESENTATIVE_NOT_FOUND','ملف المندوب غير موجود'); const id=rep.rows[0].id; const customers=await client.query(`SELECT c.*,rc.visit_order,rc.credit_limit AS assigned_credit_limit,COALESCE(sum(dm.amount),0) debt FROM representative_customers rc JOIN customers c ON c.company_id=rc.company_id AND c.id=rc.customer_id LEFT JOIN customer_debt_movements dm ON dm.company_id=c.company_id AND dm.customer_id=c.id WHERE rc.company_id=$1 AND rc.representative_id=$2 AND rc.active GROUP BY c.id,rc.visit_order,rc.credit_limit ORDER BY rc.visit_order,c.code`,[companyId,id]); const routes=await client.query(`SELECT r.*,COALESCE(json_agg(json_build_object('customerId',s.customer_id,'stopOrder',s.stop_order,'note',s.note) ORDER BY s.stop_order) FILTER(WHERE s.customer_id IS NOT NULL),'[]') stops FROM representative_routes r LEFT JOIN representative_route_stops s ON s.company_id=r.company_id AND s.route_id=r.id WHERE r.company_id=$1 AND r.representative_id=$2 GROUP BY r.id ORDER BY r.route_date NULLS LAST,r.code`,[companyId,id]); const stock=await client.query(`SELECT * FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2`,[companyId,rep.rows[0].vehicle_warehouse_id]); const catalog=await client.query(`SELECT iu.item_id,iu.unit_id,iu.conversion_factor,i.sku,i.name,COALESCE(b.barcode,i.sku) barcode,(SELECT p.amount FROM prices p WHERE p.company_id=iu.company_id AND p.item_id=iu.item_id AND p.unit_id=iu.unit_id AND p.price_type='sale' AND p.active ORDER BY p.valid_from DESC LIMIT 1) sale_price FROM item_units iu JOIN items i ON i.company_id=iu.company_id AND i.id=iu.item_id LEFT JOIN item_barcodes b ON b.company_id=iu.company_id AND b.item_id=iu.item_id AND b.unit_id=iu.unit_id WHERE iu.company_id=$1 AND i.active`,[companyId]); const custody=await client.query(`SELECT COALESCE(sum(amount),0) amount FROM representative_custody_movements WHERE company_id=$1 AND representative_id=$2`,[companyId,id]); const orders=await client.query(`SELECT * FROM representative_orders WHERE company_id=$1 AND representative_id=$2 ORDER BY occurred_at DESC LIMIT 100`,[companyId,id]); const handovers=await client.query(`SELECT * FROM representative_handovers WHERE company_id=$1 AND representative_id=$2 ORDER BY submitted_at DESC LIMIT 100`,[companyId,id]); const conflicts=await client.query(`SELECT * FROM sync_conflicts WHERE company_id=$1 AND user_id=$2 AND resolved_at IS NULL ORDER BY created_at DESC`,[companyId,context.user.id]); return {representative:mapRepresentative(rep.rows[0]),customers:customers.rows.map(r=>({...mapParty(r,'customer'),assignment:{visitOrder:r.visit_order,creditLimit:r.assigned_credit_limit==null?null:decimalString(decimal(r.assigned_credit_limit))},debt:decimalString(decimal(r.debt))})),routes:routes.rows.map(r=>({...mapRepresentativeRoute(r),stops:r.stops})),stock:stock.rows.map(mapStock),catalog:catalog.rows.map(r=>({itemId:r.item_id,unitId:r.unit_id,sku:r.sku,name:r.name,conversionFactor:decimalString(decimal(r.conversion_factor)),salePrice:r.sale_price==null?null:decimalString(decimal(r.sale_price)),barcode:r.barcode})),custody:decimalString(decimal(custody.rows[0].amount)),orders:orders.rows.map(mapRepresentativeOrder),handovers:handovers.rows.map(mapRepresentativeHandover),conflicts:conflicts.rows.map(mapConflict)}; });
  }

  async pushOperations(context, operations) {
    const results = [];
    for (const operation of operations) {
      const result = await this.#transaction({ companyId: context.company.id }, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${context.company.id}:${operation.operationId}`]);
        const existing = await client.query(
          `SELECT payload_hash, result FROM sync_operations WHERE company_id = $1 AND operation_id = $2`,
          [context.company.id, operation.operationId]
        );
        if (existing.rowCount) {
          return existing.rows[0].payload_hash === operation.payloadHash
            ? existing.rows[0].result
            : { operationId: operation.operationId, status: 'rejected', code: 'OPERATION_ID_REUSED' };
        }
        const sequenceReuse = await client.query(
          `SELECT operation_id FROM sync_operations
           WHERE company_id = $1 AND device_id = $2 AND client_sequence = $3`,
          [context.company.id, operation.deviceId, operation.clientSequence]
        );
        if (sequenceReuse.rowCount) {
          return { operationId: operation.operationId, status: 'rejected', code: 'CLIENT_SEQUENCE_REUSED' };
        }
        const operationResult = { operationId: operation.operationId, status: 'acknowledged', serverReceivedAt: new Date().toISOString() };
        if (operation.type.startsWith('representative.')) {
          await client.query('SAVEPOINT representative_operation');
          try { Object.assign(operationResult, await this.#commitRepresentativeOperation(client,context,operation)); await client.query('RELEASE SAVEPOINT representative_operation'); }
          catch(error){ if(!(error instanceof AppError)) throw error; await client.query('ROLLBACK TO SAVEPOINT representative_operation'); await client.query('RELEASE SAVEPOINT representative_operation'); Object.assign(operationResult,{status:'rejected',code:error.code,message:error.message}); }
        } else if (operation.type === 'pos.shift.open' || operation.type === 'pos.sale' || operation.type === 'pos.return' || operation.type === 'pos.shift.close') {
          await client.query('SAVEPOINT pos_operation');
          try {
            if (operation.type === 'pos.shift.open') {
              const shift = await this.#openPosShift(client, context, operation);
              operationResult.entityId = shift.id; operationResult.shift = shift;
            } else if (operation.type === 'pos.shift.close') {
              const shift = await this.#closePosShift(client, context, operation);
              operationResult.entityId = shift.id; operationResult.shift = shift;
            } else {
              const posResult = await this.#commitPosDocument(client, context, operation);
              operationResult.entityId = posResult.document.id; Object.assign(operationResult, posResult);
            }
            await client.query('RELEASE SAVEPOINT pos_operation');
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            await client.query('ROLLBACK TO SAVEPOINT pos_operation');
            await client.query('RELEASE SAVEPOINT pos_operation');
            Object.assign(operationResult, { status: 'rejected', code: error.code, message: error.message });
          }
        } else if (operation.type === 'commerce.commit') {
          await client.query('SAVEPOINT commerce_operation');
          try {
            const document = await this.#commitCommerce(client, context, operation);
            operationResult.entityId = document.id;
            operationResult.document = document;
            await client.query('RELEASE SAVEPOINT commerce_operation');
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            await client.query('ROLLBACK TO SAVEPOINT commerce_operation');
            await client.query('RELEASE SAVEPOINT commerce_operation');
            Object.assign(operationResult, { status: 'rejected', code: error.code, message: error.message });
          }
        } else if (operation.type === 'financial.record') {
          if (typeof operation.payload.kind !== 'string' || !/^-?\d+(\.\d{1,6})?$/.test(String(operation.payload.amount)) || !/^[A-Z]{3}$/.test(operation.payload.currency || '')) {
            Object.assign(operationResult, { status: 'rejected', code: 'INVALID_FINANCIAL_PAYLOAD' });
          } else {
            const record = await client.query(
              `INSERT INTO financial_records
               (company_id, source_operation_id, kind, amount, currency, occurred_at, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
              [context.company.id, operation.operationId, operation.payload.kind, operation.payload.amount,
                operation.payload.currency, operation.occurredAt, context.user.id]
            );
            operationResult.entityId = record.rows[0].id;
            await this.#change(client, context.company.id, 'financial_record', record.rows[0].id, 'upsert', record.rows[0]);
          }
        } else if (operation.type.startsWith('draft.')) {
          const entityId = operation.payload.entityId || randomUUID();
          operationResult.entityId = entityId;
          await this.#change(client, context.company.id, 'draft', entityId,
            operation.type === 'draft.delete' ? 'tombstone' : 'upsert', operation.payload);
        } else {
          Object.assign(operationResult, { status: 'rejected', code: 'UNSUPPORTED_OPERATION' });
        }
        await client.query(
          `INSERT INTO sync_operations
           (company_id, operation_id, user_id, device_id, client_sequence, schema_version, entity_version,
            dependencies, operation_type, occurred_at, payload_hash, payload, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [context.company.id, operation.operationId, context.user.id, operation.deviceId, operation.clientSequence,
            operation.schemaVersion, operation.entityVersion, JSON.stringify(operation.dependencies), operation.type,
            operation.occurredAt, operation.payloadHash, operation.payload, operationResult]
        );
        if(operationResult.status==='rejected'&&operation.type.startsWith('representative.')) await client.query(`INSERT INTO sync_conflicts(company_id,user_id,device_id,operation_id,code,message) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,operation_id) DO NOTHING`,[context.company.id,context.user.id,operation.deviceId,operation.operationId,operationResult.code,operationResult.message||null]);
        return operationResult;
      });
      results.push(result);
    }
    return results;
  }

  async pullChanges(companyId, cursor = 0, limit = 100) {
    return this.#transaction({ companyId }, async (client) => {
      const result = await client.query(
        `SELECT sequence, entity_type, entity_id, action, payload, changed_at
         FROM sync_changes WHERE company_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`,
        [companyId, cursor, limit]
      );
      const changes = result.rows.map((row) => ({
        sequence: Number(row.sequence), entityType: row.entity_type, entityId: row.entity_id,
        action: row.action, payload: row.payload, changedAt: row.changed_at
      }));
      return { changes, nextCursor: changes.at(-1)?.sequence ?? cursor, hasMore: changes.length === limit };
    });
  }

  async syncStatus(companyId, userId, deviceId) {
    return this.#transaction({ companyId }, async (client) => {
      const result = await client.query(
        `SELECT count(*) FILTER (WHERE result->>'status' = 'acknowledged') AS acknowledged,
                count(*) FILTER (WHERE result->>'status' = 'rejected') AS rejected
         FROM sync_operations WHERE company_id = $1 AND user_id = $2 AND device_id = $3`,
        [companyId, userId, deviceId]
      );
      const cursor = await client.query(`SELECT COALESCE(max(sequence), 0) AS cursor FROM sync_changes WHERE company_id = $1`, [companyId]);
      const conflicts = await client.query(`SELECT count(*) count FROM sync_conflicts WHERE company_id=$1 AND user_id=$2 AND device_id=$3 AND resolved_at IS NULL`,[companyId,userId,deviceId]);
      return {
        acknowledged: Number(result.rows[0].acknowledged), rejected: Number(result.rows[0].rejected), conflicts: Number(conflicts.rows[0].count),
        lastServerCursor: Number(cursor.rows[0].cursor)
      };
    });
  }

  async #commitRepresentativeOperation(client,context,operation){
    const p=operation.payload,companyId=context.company.id; const found=await client.query(`SELECT * FROM representatives WHERE company_id=$1 AND id=$2 AND active FOR SHARE`,[companyId,p.representativeId]); if(!found.rowCount) throw new AppError(404,'REPRESENTATIVE_NOT_FOUND','المندوب غير موجود'); const rep=found.rows[0],own=rep.user_id===context.user.id;
    if(operation.type==='representative.load'&&!context.permissions.includes('representatives.manage')) throw new AppError(403,'PERMISSION_DENIED','تحميل السيارة يحتاج صلاحية الإدارة');
    if(operation.type==='representative.handover.review'&&!context.permissions.includes('representatives.review')) throw new AppError(403,'PERMISSION_DENIED','مراجعة التسليم تحتاج صلاحية المشرف');
    if(!['representative.load','representative.handover.review'].includes(operation.type)&&!own&&!context.permissions.includes('representatives.manage')) throw new AppError(403,'REPRESENTATIVE_SCOPE_DENIED','لا يمكن تنفيذ عملية لمندوب آخر');
    const assigned=async customerId=>{const q=await client.query(`SELECT rc.*,COALESCE(rc.credit_limit,c.credit_limit) effective_credit_limit FROM representative_customers rc JOIN customers c ON c.company_id=rc.company_id AND c.id=rc.customer_id WHERE rc.company_id=$1 AND rc.representative_id=$2 AND rc.customer_id=$3 AND rc.active FOR SHARE OF rc`,[companyId,rep.id,customerId]); if(!q.rowCount) throw new AppError(403,'CUSTOMER_NOT_ASSIGNED','العميل غير مسند للمندوب'); return q.rows[0];};
    if(operation.type==='representative.load'){const transfer=await this.#stockTransfer(client,context,operation,p.sourceWarehouseId,rep.vehicle_warehouse_id,p.lines,p.transferNumber,rep.id);return{entityId:transfer.id,transfer};}
    if(operation.type==='representative.order'){await assigned(p.customerId);let total=ZERO;for(const line of p.lines)total+=multiply(decimal(line.quantity),decimal(line.unitPrice));const order=await client.query(`INSERT INTO representative_orders(id,company_id,representative_id,customer_id,order_number,currency,total,operation_id,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[p.orderId,companyId,rep.id,p.customerId,p.orderNumber,p.currency,decimalString(total),operation.operationId,operation.occurredAt,context.user.id]);for(const line of p.lines)await client.query(`INSERT INTO representative_order_lines(company_id,order_id,item_id,unit_id,quantity,unit_price,line_total) VALUES($1,$2,$3,$4,$5,$6,round($5::numeric*$6::numeric,6))`,[companyId,p.orderId,line.itemId,line.unitId,line.quantity,line.unitPrice]);const value=mapRepresentativeOrder(order.rows[0]);await this.#change(client,companyId,'representative_order',p.orderId,'upsert',value);return{entityId:p.orderId,order:value};}
    if(operation.type==='representative.sale'||operation.type==='representative.return'){const assignment=await assigned(p.partyId);const isReturn=operation.type.endsWith('return');if(!isReturn){await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${companyId}:customer:${p.partyId}:${p.currency}`]);const debt=await client.query(`SELECT COALESCE(sum(amount),0) value FROM customer_debt_movements WHERE company_id=$1 AND customer_id=$2 AND currency=$3`,[companyId,p.partyId,p.currency]);let total=ZERO;for(const line of p.lines)total+=multiply(decimal(line.quantity),decimal(line.unitPrice));total-=decimal(p.discountAmount||'0');const paid=(p.payments||[]).reduce((s,x)=>s+decimal(x.amount),ZERO);const limit=decimal(assignment.effective_credit_limit||'0');if(decimal(debt.rows[0].value)+total-paid>limit)throw new AppError(409,'CREDIT_LIMIT_EXCEEDED','البيع يتجاوز حد ائتمان العميل');}else{const original=await client.query(`SELECT representative_id FROM commerce_documents WHERE company_id=$1 AND id=$2 AND document_type='sale' FOR SHARE`,[companyId,p.originalDocumentId]);if(!original.rowCount||original.rows[0].representative_id!==rep.id)throw new AppError(403,'RETURN_REPRESENTATIVE_MISMATCH','لا يمكن إرجاع بيع مندوب آخر');const refund=(p.payments||[]).reduce((s,x)=>s+decimal(x.amount),ZERO);const custody=await client.query(`SELECT COALESCE(sum(amount),0) value FROM representative_custody_movements WHERE company_id=$1 AND representative_id=$2 AND currency=$3`,[companyId,rep.id,p.currency]);if(refund>decimal(custody.rows[0].value))throw new AppError(409,'REFUND_EXCEEDS_CUSTODY','نقد المرتجع يتجاوز عهدة المندوب');}
      const document=await this.#commitCommerce(client,context,{...operation,payload:{...p,representativeId:rep.id,warehouseId:rep.vehicle_warehouse_id,documentType:isReturn?'sale_return':'sale'}});if(p.orderId){const changed=await client.query(`UPDATE representative_orders SET status='converted',sale_document_id=$3 WHERE company_id=$1 AND id=$2 AND representative_id=$4 AND status='pending' RETURNING id`,[companyId,p.orderId,document.id,rep.id]);if(!changed.rowCount)throw new AppError(409,'ORDER_NOT_PENDING','الطلب غير صالح للتحويل');}return{entityId:document.id,document};}
    if(operation.type==='representative.collection'){await assigned(p.customerId);await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${companyId}:customer:${p.customerId}:${p.currency}`]);const debt=await client.query(`SELECT COALESCE(sum(amount),0) value FROM customer_debt_movements WHERE company_id=$1 AND customer_id=$2 AND currency=$3`,[companyId,p.customerId,p.currency]);if(decimal(p.amount)>decimal(debt.rows[0].value))throw new AppError(409,'COLLECTION_EXCEEDS_DEBT','التحصيل يتجاوز دين العميل');const collection=await client.query(`INSERT INTO representative_collections(company_id,representative_id,customer_id,receipt_number,amount,currency,operation_id,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[companyId,rep.id,p.customerId,p.receiptNumber,p.amount,p.currency,operation.operationId,operation.occurredAt,context.user.id]);await client.query(`INSERT INTO customer_debt_movements(company_id,customer_id,representative_id,operation_id,movement_type,amount,currency,occurred_at) VALUES($1,$2,$3,$4,'collection',-$5::numeric,$6,$7)`,[companyId,p.customerId,rep.id,operation.operationId,p.amount,p.currency,operation.occurredAt]);await client.query(`INSERT INTO representative_custody_movements(company_id,representative_id,operation_id,movement_type,amount,currency,reference_type,reference_id,occurred_at) VALUES($1,$2,$3,'collection',$4,$5,'collection',$6,$7)`,[companyId,rep.id,operation.operationId,p.amount,p.currency,collection.rows[0].id,operation.occurredAt]);await this.#postSimpleJournal(client,context,operation,`COL-${p.receiptNumber}`,p.currency,[['1150-REP-CASH-CUSTODY',p.amount,'0'],['1100-AR','0',p.amount]]);await this.#change(client,companyId,'representative_collection',collection.rows[0].id,'upsert',collection.rows[0]);return{entityId:collection.rows[0].id,collection:collection.rows[0]};}
    if(operation.type==='representative.handover.submit'){const custody=await client.query(`SELECT COALESCE(sum(amount),0) value FROM representative_custody_movements WHERE company_id=$1 AND representative_id=$2 AND currency=$3`,[companyId,rep.id,p.currency]);for(const line of p.lines||[]){const balance=await client.query(`SELECT quantity FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`,[companyId,rep.vehicle_warehouse_id,line.itemId]);if(!balance.rowCount||decimal(balance.rows[0].quantity)<decimal(line.quantity))throw new AppError(409,'INSUFFICIENT_VEHICLE_STOCK','بضاعة السيارة لا تكفي للتسليم');}const h=await client.query(`INSERT INTO representative_handovers(id,company_id,representative_id,destination_warehouse_id,handover_number,expected_cash,submitted_cash,currency,submit_operation_id,submitted_at,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[p.handoverId,companyId,rep.id,p.destinationWarehouseId,p.handoverNumber,custody.rows[0].value,p.submittedCash,p.currency,operation.operationId,operation.occurredAt,context.user.id]);for(const line of p.lines||[])await client.query(`INSERT INTO representative_handover_lines(company_id,handover_id,item_id,quantity) VALUES($1,$2,$3,$4)`,[companyId,p.handoverId,line.itemId,line.quantity]);const value=mapRepresentativeHandover(h.rows[0]);await this.#change(client,companyId,'representative_handover',h.rows[0].id,'upsert',value);return{entityId:h.rows[0].id,handover:value};}
    if(operation.type==='representative.handover.review'){const h=await client.query(`SELECT * FROM representative_handovers WHERE company_id=$1 AND id=$2 AND representative_id=$3 AND status='submitted' FOR UPDATE`,[companyId,p.handoverId,rep.id]);if(!h.rowCount)throw new AppError(409,'HANDOVER_NOT_SUBMITTED','التسليم غير متاح للمراجعة');const custody=await client.query(`SELECT COALESCE(sum(amount),0) value FROM representative_custody_movements WHERE company_id=$1 AND representative_id=$2 AND currency=$3`,[companyId,rep.id,h.rows[0].currency]);if(decimal(p.reviewedCash)>decimal(custody.rows[0].value))throw new AppError(409,'HANDOVER_EXCEEDS_CUSTODY','النقد المراجع يتجاوز العهدة');const lines=await client.query(`SELECT item_id "itemId",quantity::text FROM representative_handover_lines WHERE company_id=$1 AND handover_id=$2`,[companyId,p.handoverId]);if(lines.rowCount)await this.#stockTransfer(client,context,operation,rep.vehicle_warehouse_id,h.rows[0].destination_warehouse_id,lines.rows,`RET-${h.rows[0].handover_number}`,rep.id);await client.query(`INSERT INTO representative_custody_movements(company_id,representative_id,operation_id,movement_type,amount,currency,reference_type,reference_id,occurred_at) VALUES($1,$2,$3,'cash_handover',-$4::numeric,$5,'handover',$6,$7)`,[companyId,rep.id,operation.operationId,p.reviewedCash,h.rows[0].currency,p.handoverId,operation.occurredAt]);await this.#postSimpleJournal(client,context,operation,`HND-${h.rows[0].handover_number}`,h.rows[0].currency,[['1000-CASH',p.reviewedCash,'0'],['1150-REP-CASH-CUSTODY','0',p.reviewedCash]]);const updated=await client.query(`UPDATE representative_handovers SET status='reviewed',reviewed_cash=$3,cash_variance=$3-expected_cash,review_operation_id=$4,reviewed_at=$5,reviewed_by=$6 WHERE company_id=$1 AND id=$2 RETURNING *`,[companyId,p.handoverId,p.reviewedCash,operation.operationId,operation.occurredAt,context.user.id]);const value=mapRepresentativeHandover(updated.rows[0]);await this.#change(client,companyId,'representative_handover',p.handoverId,'upsert',value);return{entityId:p.handoverId,handover:value};}
    throw new AppError(400,'UNSUPPORTED_OPERATION','عملية المندوب غير مدعومة');
  }

  async #stockTransfer(client,context,operation,sourceId,destinationId,lines,number,representativeId){if(sourceId===destinationId)throw new AppError(400,'SAME_TRANSFER_WAREHOUSE','مخزنا التحويل متطابقان');const transfer=await client.query(`INSERT INTO stock_transfers(company_id,representative_id,source_warehouse_id,destination_warehouse_id,transfer_number,operation_id,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[context.company.id,representativeId,sourceId,destinationId,number,operation.operationId,operation.occurredAt,context.user.id]);const stored=[];for(const line of lines){await client.query(`INSERT INTO stock_balances(company_id,warehouse_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[context.company.id,sourceId,line.itemId]);await client.query(`INSERT INTO stock_balances(company_id,warehouse_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[context.company.id,destinationId,line.itemId]);const locked=await client.query(`SELECT * FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND warehouse_id=ANY($3::uuid[]) ORDER BY warehouse_id FOR UPDATE`,[context.company.id,line.itemId,[sourceId,destinationId]]);const source=locked.rows.find(r=>r.warehouse_id===sourceId),dest=locked.rows.find(r=>r.warehouse_id===destinationId);if(!source||decimal(source.quantity)<decimal(line.quantity))throw new AppError(409,'INSUFFICIENT_STOCK','المخزون لا يكفي للتحويل');await client.query(`UPDATE stock_balances SET quantity=quantity-$4::numeric,average_cost=CASE WHEN quantity-$4::numeric=0 THEN 0 ELSE average_cost END,version=version+1,updated_at=now() WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`,[context.company.id,sourceId,line.itemId,line.quantity]);await client.query(`UPDATE stock_balances SET average_cost=CASE WHEN quantity+$4::numeric=0 THEN 0 ELSE round((quantity*average_cost+$4::numeric*$5::numeric)/(quantity+$4::numeric),6) END,quantity=quantity+$4::numeric,version=version+1,updated_at=now() WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`,[context.company.id,destinationId,line.itemId,line.quantity,source.average_cost]);const inserted=await client.query(`INSERT INTO stock_transfer_lines(company_id,transfer_id,item_id,quantity,unit_cost) VALUES($1,$2,$3,$4,$5) RETURNING *`,[context.company.id,transfer.rows[0].id,line.itemId,line.quantity,source.average_cost]);stored.push(inserted.rows[0]);}const value={id:transfer.rows[0].id,companyId:context.company.id,representativeId,sourceWarehouseId:sourceId,destinationWarehouseId:destinationId,transferNumber:number,status:'posted',operationId:operation.operationId,occurredAt:operation.occurredAt,lines:stored};await this.#audit(client,context.company.id,context.user.id,'stock.transfer.posted','stock_transfer',value.id,{});await this.#change(client,context.company.id,'stock_transfer',value.id,'upsert',value);return value;}
  async #postSimpleJournal(client,context,operation,number,currency,lines){const entry=await client.query(`INSERT INTO journal_entries(company_id,entry_number,status,currency,description,occurred_at,created_by) VALUES($1,$2,'draft',$3,$2,$4,$5) RETURNING id`,[context.company.id,number,currency,operation.occurredAt,context.user.id]);for(const [account,debit,credit]of lines)await client.query(`INSERT INTO journal_lines(company_id,journal_entry_id,account_code,debit,credit) VALUES($1,$2,$3,$4,$5)`,[context.company.id,entry.rows[0].id,account,debit,credit]);await client.query(`UPDATE journal_entries SET status='posted' WHERE company_id=$1 AND id=$2`,[context.company.id,entry.rows[0].id]);}

  async #openPosShift(client, context, operation) {
    const payload = operation.payload;
    const device = await client.query(`SELECT * FROM pos_devices WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [context.company.id, payload.deviceId]);
    if (!device.rowCount) throw new AppError(404, 'POS_DEVICE_NOT_FOUND', 'جهاز الكاشير غير موجود');
    try {
      const result = await client.query(
        `INSERT INTO pos_shifts(id,company_id,device_id,opened_by,opening_float,opened_at,open_operation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [payload.shiftId, context.company.id, payload.deviceId, context.user.id, payload.openingFloat, operation.occurredAt, operation.operationId]
      );
      await this.#audit(client, context.company.id, context.user.id, 'pos.shift.opened', 'pos_shift', payload.shiftId, {});
      await this.#change(client, context.company.id, 'pos_shift', payload.shiftId, 'upsert', result.rows[0]);
      return mapPosShift(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'POS_SHIFT_ALREADY_OPEN', 'يوجد شفت مفتوح للجهاز');
      throw error;
    }
  }

  async #commitPosDocument(client, context, operation) {
    const payload = operation.payload;
    const device = await client.query(`SELECT * FROM pos_devices WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [context.company.id, payload.deviceId]);
    const shift = await client.query(
      `SELECT * FROM pos_shifts WHERE company_id=$1 AND id=$2 AND device_id=$3 AND status='open' FOR UPDATE`,
      [context.company.id, payload.shiftId, payload.deviceId]
    );
    if (!device.rowCount || !shift.rowCount) throw new AppError(409, 'POS_SHIFT_NOT_OPEN', 'لا يوجد شفت مفتوح لهذا الجهاز');
    if (device.rows[0].interface_mode !== payload.interfaceMode) throw new AppError(400, 'POS_INTERFACE_MISMATCH', 'واجهة البيع لا تطابق إعداد الجهاز');
    const isReturn = operation.type === 'pos.return';
    let gross = ZERO;
    if (!isReturn) {
      for (const line of payload.lines) gross += multiply(decimal(line.quantity, { positive: true }), decimal(line.unitPrice, { nonNegative: true }));
      const discount = decimal(payload.discountAmount || '0', { nonNegative: true });
      const percent = gross === ZERO ? ZERO : divide(discount, gross) * 100n;
      const policy = await client.query(
        `SELECT max_discount_percent FROM pos_discount_policies WHERE company_id=$1 AND (device_id=$2 OR device_id IS NULL)
         ORDER BY device_id NULLS LAST LIMIT 1`, [context.company.id, payload.deviceId]
      );
      const maximum = policy.rowCount ? decimal(policy.rows[0].max_discount_percent) : ZERO;
      if (percent > maximum && !context.permissions.includes('sales.discount.override')) throw new AppError(403, 'DISCOUNT_APPROVAL_REQUIRED', 'الخصم يتجاوز صلاحية الكاشير');
    }
    const lockedAllocations = [];
    const sortedLines = [...payload.lines].sort((left, right) => String(left.itemId).localeCompare(String(right.itemId)));
    for (const line of sortedLines) {
      const relation = await client.query(
        `SELECT conversion_factor FROM item_units WHERE company_id=$1 AND item_id=$2 AND unit_id=$3`,
        [context.company.id, line.itemId, line.unitId]
      );
      if (!relation.rowCount) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
      const baseQuantity = multiply(decimal(line.quantity, { positive: true }), decimal(relation.rows[0].conversion_factor));
      const allocation = await client.query(
        `SELECT * FROM offline_allocations WHERE company_id=$1 AND device_id=$2 AND item_id=$3
         AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE`, [context.company.id, payload.deviceId, line.itemId]
      );
      if (!allocation.rowCount && payload.offlineOrigin) throw new AppError(409, 'OFFLINE_ALLOCATION_REQUIRED', 'لا يوجد مخصص صالح للمادة على الجهاز');
      if (!allocation.rowCount) continue;
      if (!isReturn && decimal(allocation.rows[0].allocated_quantity) - decimal(allocation.rows[0].consumed_quantity) < baseQuantity) {
        throw new AppError(409, 'OFFLINE_ALLOCATION_EXCEEDED', 'كمية البيع تتجاوز مخصص الجهاز');
      }
      lockedAllocations.push({ row: allocation.rows[0], baseQuantity });
    }
    const commerceOperation = {
      ...operation,
      payload: {
        ...payload, documentType: isReturn ? 'sale_return' : 'sale', warehouseId: device.rows[0].warehouse_id,
        posShiftId: shift.rows[0].id, interfaceMode: device.rows[0].interface_mode,
        orderContext: payload.orderContext || {}, discountAmount: isReturn ? '0.000000' : payload.discountAmount || '0.000000'
      }
    };
    const document = await this.#commitCommerce(client, context, commerceOperation);
    for (const allocation of lockedAllocations) {
      const consumed = decimal(allocation.row.consumed_quantity);
      const updated = isReturn ? (consumed > allocation.baseQuantity ? consumed - allocation.baseQuantity : ZERO) : consumed + allocation.baseQuantity;
      await client.query(
        `UPDATE offline_allocations SET consumed_quantity=$4,version=version+1,updated_at=now()
         WHERE company_id=$1 AND device_id=$2 AND item_id=$3`,
        [context.company.id, payload.deviceId, allocation.row.item_id, decimalString(updated)]
      );
    }
    const receiptPayload = { company: context.company.legalName, device: device.rows[0].name, document, cashier: context.user.displayName };
    const receipt = await client.query(
      `INSERT INTO pos_receipts(company_id,document_id,shift_id,receipt_number,receipt_payload)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [context.company.id, document.id, shift.rows[0].id, `RCP-${device.rows[0].code}-${operation.clientSequence}`, receiptPayload]
    );
    await this.#change(client, context.company.id, 'pos_receipt', receipt.rows[0].id, 'upsert', receipt.rows[0]);
    return { document, receipt: mapReceipt(receipt.rows[0]) };
  }

  async #closePosShift(client, context, operation) {
    const payload = operation.payload;
    const shift = await client.query(
      `SELECT * FROM pos_shifts WHERE company_id=$1 AND id=$2 AND device_id=$3 AND status='open' FOR UPDATE`,
      [context.company.id, payload.shiftId, payload.deviceId]
    );
    if (!shift.rowCount) throw new AppError(409, 'POS_SHIFT_NOT_OPEN', 'الشفت غير مفتوح');
    const cash = await client.query(
      `SELECT round($3::numeric + COALESCE(sum(CASE
         WHEN d.document_type='sale' THEN p.amount
         WHEN d.document_type='sale_return' THEN -p.amount ELSE 0 END),0),6)::text AS expected
       FROM commerce_documents d JOIN payments p ON p.company_id=d.company_id AND p.document_id=d.id AND p.method='cash'
       WHERE d.company_id=$1 AND d.pos_shift_id=$2`,
      [context.company.id, payload.shiftId, shift.rows[0].opening_float]
    );
    const expected = decimalString(decimal(cash.rows[0].expected));
    const counted = decimalString(decimal(payload.countedCash, { nonNegative: true }));
    const variance = decimalString(decimal(counted) - decimal(expected));
    const result = await client.query(
      `UPDATE pos_shifts SET status='closed',expected_cash=$4,counted_cash=$5,variance=$6,
         closed_by=$7,close_operation_id=$8,close_submitted_at=$9,closed_at=now()
       WHERE company_id=$1 AND id=$2 AND device_id=$3 RETURNING *`,
      [context.company.id, payload.shiftId, payload.deviceId, expected, counted, variance,
        context.user.id, operation.operationId, operation.occurredAt]
    );
    await this.#audit(client, context.company.id, context.user.id, 'pos.shift.closed', 'pos_shift', payload.shiftId, { variance });
    await this.#change(client, context.company.id, 'pos_shift', payload.shiftId, 'upsert', result.rows[0]);
    return mapPosShift(result.rows[0]);
  }

  async #commitCommerce(client, context, operation) {
    const companyId = context.company.id;
    const payload = operation.payload;
    const types = ['purchase', 'sale', 'purchase_return', 'sale_return'];
    if (!types.includes(payload.documentType)) throw new AppError(400, 'INVALID_DOCUMENT_TYPE', 'نوع المستند غير صالح');
    if (!Array.isArray(payload.lines) || !payload.lines.length) throw new AppError(400, 'DOCUMENT_LINES_REQUIRED', 'بنود المستند مطلوبة');
    const warehouse = await client.query(`SELECT * FROM warehouses WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [companyId, payload.warehouseId]);
    if (!warehouse.rowCount) throw new AppError(400, 'WAREHOUSE_NOT_FOUND', 'المخزن غير موجود');
    const isSale = payload.documentType.startsWith('sale');
    const isReturn = payload.documentType.endsWith('_return');
    if (payload.partyId) {
      const party = await client.query(
        `SELECT 1 FROM ${isSale ? 'customers' : 'suppliers'} WHERE company_id=$1 AND id=$2 AND active`, [companyId, payload.partyId]
      );
      if (!party.rowCount) throw new AppError(400, 'PARTY_NOT_FOUND', 'العميل أو المورد غير موجود');
    }
    let original = null;
    if (isReturn) {
      const expected = payload.documentType === 'sale_return' ? 'sale' : 'purchase';
      const result = await client.query(
        `SELECT * FROM commerce_documents WHERE company_id=$1 AND id=$2 AND document_type=$3 AND status='posted' FOR SHARE`,
        [companyId, payload.originalDocumentId, expected]
      );
      if (!result.rowCount) throw new AppError(400, 'ORIGINAL_DOCUMENT_INVALID', 'المستند الأصلي غير صالح');
      original = result.rows[0];
      if (original.currency !== payload.currency) throw new AppError(400, 'RETURN_CURRENCY_MISMATCH', 'عملة المرتجع يجب أن تطابق المستند الأصلي');
    }

    const computed = [];
    const sortedLines = [...payload.lines].sort((left, right) => String(left.itemId).localeCompare(String(right.itemId)));
    if (new Set(sortedLines.map((line) => line.itemId)).size !== sortedLines.length) {
      throw new AppError(400, 'DUPLICATE_DOCUMENT_ITEM', 'لا تكرر المادة في المستند؛ اجمع الكمية في بند واحد');
    }
    for (const input of sortedLines) {
      const relation = await client.query(
        `SELECT iu.conversion_factor FROM item_units iu JOIN items i ON i.company_id=iu.company_id AND i.id=iu.item_id
         WHERE iu.company_id=$1 AND iu.item_id=$2 AND iu.unit_id=$3 AND i.active`,
        [companyId, input.itemId, input.unitId]
      );
      if (!relation.rowCount) throw new AppError(400, 'ITEM_UNIT_NOT_FOUND', 'وحدة المادة غير موجودة');
      let unitPrice = input.unitPrice;
      let unitCost = null;
      let originalLineId = null;
      if (isReturn) {
        const originalLine = await client.query(
          `SELECT l.* FROM commerce_document_lines l
           WHERE l.company_id=$1 AND l.id=$2 AND l.document_id=$3 AND l.item_id=$4 AND l.unit_id=$5 FOR SHARE`,
          [companyId, input.originalLineId, original.id, input.itemId, input.unitId]
        );
        if (!originalLine.rowCount) throw new AppError(400, 'ORIGINAL_LINE_INVALID', 'بند المستند الأصلي غير صالح');
        const quantities = await client.query(
          `SELECT l.base_quantity AS original_quantity,
             COALESCE((SELECT sum(rl.base_quantity) FROM commerce_document_lines rl
               JOIN commerce_documents rd ON rd.company_id=rl.company_id AND rd.id=rl.document_id
               WHERE rl.company_id=$1 AND rl.original_line_id=l.id AND rd.status='posted'),0) AS returned_quantity,
             round($3::numeric * $4::numeric,6) AS requested_quantity
           FROM commerce_document_lines l WHERE l.company_id=$1 AND l.id=$2`,
          [companyId, input.originalLineId, input.quantity, relation.rows[0].conversion_factor]
        );
        const quantityRow = quantities.rows[0];
        const exceed = await client.query(`SELECT ($1::numeric + $2::numeric) > $3::numeric AS value`, [quantityRow.returned_quantity, quantityRow.requested_quantity, quantityRow.original_quantity]);
        if (exceed.rows[0].value) throw new AppError(409, 'RETURN_QUANTITY_EXCEEDED', 'كمية المرتجع تتجاوز الأصل');
        unitPrice = originalLine.rows[0].unit_price;
        if (decimal(original.gross_amount || original.subtotal) > ZERO && decimal(original.discount_amount || '0') > ZERO) {
          const effective = await client.query(
            `SELECT round($1::numeric * ($2::numeric / $3::numeric),6)::text AS value`,
            [unitPrice, original.subtotal, original.gross_amount]
          );
          unitPrice = effective.rows[0].value;
        }
        unitCost = originalLine.rows[0].unit_cost;
        originalLineId = originalLine.rows[0].id;
      }
      const values = await client.query(
        `SELECT round($1::numeric,6)::text AS quantity, round($2::numeric,6)::text AS factor,
                round($1::numeric*$2::numeric,6)::text AS base_quantity,
                round($3::numeric,6)::text AS unit_price,
                round($1::numeric*$3::numeric,6)::text AS line_total`,
        [input.quantity, relation.rows[0].conversion_factor, unitPrice]
      );
      const value = values.rows[0];
      if (decimal(value.quantity) <= ZERO || decimal(value.base_quantity) <= ZERO || decimal(value.unit_price) < ZERO) {
        throw new AppError(400, 'INVALID_LINE_DECIMAL', 'الكمية أو السعر غير صالح');
      }
      await client.query(
        `INSERT INTO stock_balances(company_id,warehouse_id,item_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`, [companyId, payload.warehouseId, input.itemId]
      );
      const balance = await client.query(
        `SELECT * FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 FOR UPDATE`,
        [companyId, payload.warehouseId, input.itemId]
      );
      const inbound = payload.documentType === 'purchase' || payload.documentType === 'sale_return';
      if (!inbound) {
        const reserved = await client.query(
          `SELECT COALESCE(sum(allocated_quantity-consumed_quantity),0) AS quantity
           FROM offline_allocations WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3
             AND ($4::uuid IS NULL OR device_id<>$4::uuid)`,
          [companyId, payload.warehouseId, input.itemId, payload.deviceId || null]
        );
        const enough = await client.query(`SELECT ($1::numeric-$3::numeric) >= $2::numeric AS value`, [balance.rows[0].quantity, value.base_quantity, reserved.rows[0].quantity]);
        if (!enough.rows[0].value) {
          if (decimal(balance.rows[0].quantity) < decimal(value.base_quantity)) throw new AppError(409, 'INSUFFICIENT_STOCK', 'المخزون غير كافٍ');
          throw new AppError(409, 'STOCK_RESERVED_FOR_OFFLINE', 'الكمية المتاحة محجوزة لأجهزة أوف لاين');
        }
        unitCost = balance.rows[0].average_cost;
      } else if (payload.documentType === 'purchase') {
        const cost = await client.query(`SELECT round($1::numeric/$2::numeric,6)::text AS value`, [value.line_total, value.base_quantity]);
        unitCost = cost.rows[0].value;
      }
      computed.push({ input, ...value, unitCost, originalLineId, oldQuantity: balance.rows[0].quantity, oldCost: balance.rows[0].average_cost, inbound });
    }

    const gross = await this.#sumNumeric(client, computed.map((line) => line.line_total));
    const discount = decimalString(decimal(payload.discountAmount || '0', { nonNegative: true }));
    if (decimal(discount) > decimal(gross)) throw new AppError(400, 'DISCOUNT_EXCEEDS_TOTAL', 'الخصم يتجاوز إجمالي المستند');
    const subtotal = decimalString(decimal(gross) - decimal(discount));
    const payments = Array.isArray(payload.payments) ? payload.payments : [];
    const paid = await this.#sumNumeric(client, payments.map((payment) => payment.amount));
    if (decimal(paid) > decimal(subtotal)) throw new AppError(400, 'PAYMENTS_EXCEED_TOTAL', 'الدفعات تتجاوز قيمة المستند');
    if (isSale && decimal(subtotal) > decimal(paid) && !payload.partyId) throw new AppError(400, 'CUSTOMER_REQUIRED_FOR_CREDIT', 'العميل مطلوب للبيع الآجل أو المختلط');
    const due = decimalString(decimal(subtotal) - decimal(paid));
    let document;
    try {
      const result = await client.query(
        `INSERT INTO commerce_documents
         (company_id,document_type,document_number,warehouse_id,customer_id,supplier_id,original_document_id,
          currency,subtotal,paid_amount,due_amount,operation_id,occurred_at,created_by,
          gross_amount,discount_amount,pos_shift_id,interface_mode,order_context,representative_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [companyId, payload.documentType, payload.documentNumber, payload.warehouseId,
          isSale ? payload.partyId || null : null, isSale ? null : payload.partyId || null, original?.id || null,
          payload.currency, subtotal, paid, due, operation.operationId, operation.occurredAt, context.user.id,
          gross, discount, payload.posShiftId || null, payload.interfaceMode || null, payload.orderContext || {}, payload.representativeId || null]
      );
      document = result.rows[0];
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'DOCUMENT_NUMBER_EXISTS', 'رقم المستند مستخدم');
      throw error;
    }
    const movement = await client.query(
      `INSERT INTO stock_movements(company_id,document_id,warehouse_id,movement_type,occurred_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, document.id, payload.warehouseId, payload.documentType, operation.occurredAt]
    );
    const storedLines = [];
    for (const line of computed) {
      const inserted = await client.query(
        `INSERT INTO commerce_document_lines
         (company_id,document_id,item_id,unit_id,original_line_id,quantity,conversion_factor,base_quantity,unit_price,line_total,unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [companyId, document.id, line.input.itemId, line.input.unitId, line.originalLineId, line.quantity,
          line.factor, line.base_quantity, line.unit_price, line.line_total, line.unitCost]
      );
      const delta = line.inbound ? line.base_quantity : decimalString(-decimal(line.base_quantity));
      await client.query(
        `INSERT INTO stock_movement_lines(company_id,movement_id,item_id,quantity_delta,unit_cost)
         VALUES ($1,$2,$3,$4,$5)`, [companyId, movement.rows[0].id, line.input.itemId, delta, line.unitCost]
      );
      if (line.inbound) {
        await client.query(
          `UPDATE stock_balances SET
             average_cost=round(((quantity*average_cost)+($4::numeric*$5::numeric))/(quantity+$4::numeric),6),
             quantity=round(quantity+$4::numeric,6), version=version+1, updated_at=now()
           WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [companyId, payload.warehouseId, line.input.itemId, line.base_quantity, line.unitCost]
        );
      } else {
        await client.query(
          `UPDATE stock_balances SET quantity=round(quantity-$4::numeric,6),
             average_cost=CASE WHEN quantity-$4::numeric=0 THEN 0 ELSE average_cost END,
             version=version+1, updated_at=now()
           WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`,
          [companyId, payload.warehouseId, line.input.itemId, line.base_quantity]
        );
      }
      storedLines.push(mapDocumentLine(inserted.rows[0]));
    }
    for (const payment of payments) {
      if (!['cash', 'bank', 'card'].includes(payment.method) || decimal(payment.amount) <= ZERO) throw new AppError(400, 'INVALID_PAYMENT', 'بيانات الدفعة غير صالحة');
      await client.query(
        `INSERT INTO payments(company_id,document_id,method,amount,reference) VALUES ($1,$2,$3,$4,$5)`,
        [companyId, document.id, payment.method, payment.amount, payment.reference || null]
      );
    }
    const inventoryCost = await this.#sumNumeric(client, computed.map((line) => decimalString(multiply(decimal(line.base_quantity), decimal(line.unitCost)))));
    await this.#postCommerceJournal(client, context, document, inventoryCost);
    if(isSale&&document.customer_id&&decimal(document.due_amount)>ZERO) await client.query(`INSERT INTO customer_debt_movements(company_id,customer_id,representative_id,document_id,operation_id,movement_type,amount,currency,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[companyId,document.customer_id,document.representative_id,document.id,operation.operationId,isReturn?'sale_return':'sale',isReturn?decimalString(-decimal(document.due_amount)):document.due_amount,document.currency,operation.occurredAt]);
    if(document.representative_id&&decimal(document.paid_amount)>ZERO) await client.query(`INSERT INTO representative_custody_movements(company_id,representative_id,operation_id,movement_type,amount,currency,reference_type,reference_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,'commerce_document',$7,$8)`,[companyId,document.representative_id,operation.operationId,isReturn?'return_cash':'sale_cash',isReturn?decimalString(-decimal(document.paid_amount)):document.paid_amount,document.currency,document.id,operation.occurredAt]);
    const publicDocument = { ...mapDocument(document), lines: storedLines, payments: payments.map((payment) => ({ ...payment, amount: decimalString(decimal(payment.amount)) })) };
    await client.query(
      `INSERT INTO server_outbox(company_id,event_type,aggregate_type,aggregate_id,payload)
       VALUES ($1,'commerce.document.posted','commerce_document',$2,$3)`,
      [companyId, document.id, { documentType: payload.documentType, total: subtotal }]
    );
    await this.#audit(client, companyId, context.user.id, 'commerce.document.posted', 'commerce_document', document.id, { documentType: payload.documentType });
    await this.#change(client, companyId, 'commerce_document', document.id, 'upsert', publicDocument);
    for (const line of computed) {
      const balance = await client.query(`SELECT * FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`, [companyId, payload.warehouseId, line.input.itemId]);
      await this.#change(client, companyId, 'stock_balance', line.input.itemId, 'upsert', mapStock(balance.rows[0]));
    }
    return publicDocument;
  }

  async #postCommerceJournal(client, context, document, inventoryCostText) {
    const total = decimal(document.subtotal);
    const paid = decimal(document.paid_amount);
    const due = total - paid;
    const inventoryCost = decimal(inventoryCostText);
    const lines = [];
    const add = (account, debit, credit) => { if (debit || credit) lines.push({ account, debit, credit }); };
    const cashAccount = document.representative_id ? '1150-REP-CASH-CUSTODY' : '1000-CASH';
    if (document.document_type === 'purchase') {
      add('1200-INVENTORY', total, ZERO); add('1000-CASH', ZERO, paid); add('2100-AP', ZERO, due);
    } else if (document.document_type === 'sale') {
      add(cashAccount, paid, ZERO); add('1100-AR', due, ZERO); add('4100-SALES', ZERO, total);
      add('5100-COGS', inventoryCost, ZERO); add('1200-INVENTORY', ZERO, inventoryCost);
    } else if (document.document_type === 'purchase_return') {
      add('1000-CASH', paid, ZERO); add('2100-AP', due, ZERO); add('1200-INVENTORY', ZERO, inventoryCost);
      if (total > inventoryCost) add('4300-PURCHASE-RETURN-VARIANCE', ZERO, total - inventoryCost);
      if (inventoryCost > total) add('5300-PURCHASE-RETURN-VARIANCE', inventoryCost - total, ZERO);
    } else {
      add('4200-SALES-RETURNS', total, ZERO); add(cashAccount, ZERO, paid); add('1100-AR', ZERO, due);
      add('1200-INVENTORY', inventoryCost, ZERO); add('5100-COGS', ZERO, inventoryCost);
    }
    const debit = lines.reduce((sum, line) => sum + line.debit, ZERO);
    const credit = lines.reduce((sum, line) => sum + line.credit, ZERO);
    if (debit !== credit) throw new AppError(500, 'UNBALANCED_JOURNAL', 'القيد غير متوازن');
    const entry = await client.query(
      `INSERT INTO journal_entries(company_id,entry_number,status,currency,description,occurred_at,created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6) RETURNING id`,
      [context.company.id, `COM-${document.document_type}-${document.document_number}`, document.currency,
        `Commerce ${document.document_type} ${document.document_number}`, document.occurred_at, context.user.id]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_lines(company_id,journal_entry_id,account_code,debit,credit) VALUES ($1,$2,$3,$4,$5)`,
        [context.company.id, entry.rows[0].id, line.account, decimalString(line.debit), decimalString(line.credit)]
      );
    }
    await client.query(`UPDATE journal_entries SET status='posted' WHERE company_id=$1 AND id=$2`, [context.company.id, entry.rows[0].id]);
  }

  async #sumNumeric(client, values) {
    if (!values.length) return '0.000000';
    const result = await client.query(`SELECT round(sum(value::numeric),6)::text AS value FROM unnest($1::text[]) AS value`, [values]);
    return decimalString(decimal(result.rows[0].value || '0'));
  }

  async #tenantWrite(companyId, conflictCode, callback) {
    try {
      return await this.#transaction({ companyId }, callback);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, conflictCode, 'القيمة مستخدمة');
      if (error.code === '23503') throw new AppError(400, 'RELATED_ENTITY_NOT_FOUND', 'السجل المرتبط غير موجود ضمن الشركة');
      if (error.code === '23514' || error.code === '22P02') throw new AppError(400, 'INVALID_VALUE', 'قيمة غير صالحة');
      throw error;
    }
  }

  async #transaction(context, callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (context.companyId) await client.query(`SELECT set_config('app.company_id', $1, true)`, [context.companyId]);
      if (context.platform) await client.query(`SELECT set_config('app.platform_access', 'true', true)`);
      const value = await callback(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async #audit(client, companyId, actorUserId, action, entityType, entityId, metadata) {
    await client.query(
      `INSERT INTO audit_events (company_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`, [companyId, actorUserId, action, entityType, entityId, metadata]
    );
  }

  async #change(client, companyId, entityType, entityId, action, payload) {
    await client.query(
      `INSERT INTO sync_changes (company_id, entity_type, entity_id, action, payload) VALUES ($1, $2, $3, $4, $5)`,
      [companyId, entityType, entityId, action, payload]
    );
  }
}

function mapCompany(row) {
  return {
    id: row.id, code: row.code, legalName: row.legal_name, status: row.status,
    timezone: row.timezone, currency: row.currency, ownerUserId: row.owner_user_id,
    approvedAt: row.approved_at, createdAt: row.created_at
  };
}

function mapUser(row, includePassword = false) {
  return {
    id: row.id, companyId: row.company_id, username: row.username, displayName: row.display_name,
    status: row.status, platformAdmin: row.platform_admin, createdAt: row.created_at,
    ...(includePassword ? { passwordHash: row.password_hash } : {})
  };
}

function mapSession(row) {
  return {
    id: row.id, userId: row.user_id, deviceId: row.device_id,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at
  };
}

function mapUnit(row) {
  return { id: row.id, companyId: row.company_id, code: row.code, name: row.name, decimalPlaces: row.decimal_places };
}

function mapItem(row) {
  return { id: row.id, companyId: row.company_id, sku: row.sku, name: row.name, baseUnitId: row.base_unit_id, active: row.active };
}

function mapItemUnit(row) {
  return {
    id: row.id, companyId: row.company_id, itemId: row.item_id, unitId: row.unit_id,
    conversionFactor: decimalString(decimal(row.conversion_factor)), isBase: row.is_base
  };
}

function mapPrice(row) {
  return {
    id: row.id, companyId: row.company_id, itemId: row.item_id, unitId: row.unit_id,
    priceType: row.price_type, currency: row.currency, amount: decimalString(decimal(row.amount)),
    active: row.active, validFrom: row.valid_from, validTo: row.valid_to
  };
}

function mapParty(row, type) {
  return {
    id: row.id, companyId: row.company_id, code: row.code, name: row.name, phone: row.phone,
    active: row.active, ...(type === 'customer' ? { creditLimit: decimalString(decimal(row.credit_limit)), province: row.province || '', district: row.district || '', address: row.address || '' } : {})
  };
}

function mapWarehouse(row) {
  return {
    id: row.id, companyId: row.company_id, branchId: row.branch_id, code: row.code,
    name: row.name, kind: row.kind, active: row.active
  };
}

function mapStock(row) {
  return {
    companyId: row.company_id, warehouseId: row.warehouse_id, itemId: row.item_id,
    quantity: decimalString(decimal(row.quantity)), averageCost: decimalString(decimal(row.average_cost)),
    version: Number(row.version), updatedAt: row.updated_at
  };
}

function mapDocument(row) {
  return {
    id: row.id, companyId: row.company_id, documentType: row.document_type,
    documentNumber: row.document_number, status: row.status, warehouseId: row.warehouse_id,
    customerId: row.customer_id, supplierId: row.supplier_id, originalDocumentId: row.original_document_id,
    currency: row.currency, subtotal: decimalString(decimal(row.subtotal)), paidAmount: decimalString(decimal(row.paid_amount)),
    grossAmount: decimalString(decimal(row.gross_amount ?? row.subtotal)), discountAmount: decimalString(decimal(row.discount_amount ?? '0')),
    posShiftId: row.pos_shift_id ?? null, interfaceMode: row.interface_mode ?? null, orderContext: row.order_context ?? {},
    representativeId: row.representative_id ?? null,
    dueAmount: decimalString(decimal(row.due_amount)), operationId: row.operation_id,
    occurredAt: row.occurred_at, postedAt: row.posted_at, createdBy: row.created_by
  };
}

function mapDocumentLine(row) {
  return {
    id: row.id, itemId: row.item_id, unitId: row.unit_id, originalLineId: row.original_line_id,
    quantity: decimalString(decimal(row.quantity)), conversionFactor: decimalString(decimal(row.conversion_factor)),
    baseQuantity: decimalString(decimal(row.base_quantity)), unitPrice: decimalString(decimal(row.unit_price)),
    lineTotal: decimalString(decimal(row.line_total)), unitCost: decimalString(decimal(row.unit_cost))
  };
}

function mapBarcode(row) {
  return { id: row.id, companyId: row.company_id, itemId: row.item_id, unitId: row.unit_id, barcode: row.barcode };
}

function mapPosDevice(row) {
  return {
    id: row.id, companyId: row.company_id, branchId: row.branch_id, warehouseId: row.warehouse_id,
    code: row.code, name: row.name, interfaceMode: row.interface_mode,
    offlineEnabled: row.offline_enabled, active: row.active
  };
}

function mapAllocation(row) {
  return {
    companyId: row.company_id, deviceId: row.device_id, warehouseId: row.warehouse_id, itemId: row.item_id,
    allocatedQuantity: decimalString(decimal(row.allocated_quantity)), consumedQuantity: decimalString(decimal(row.consumed_quantity)),
    version: Number(row.version), expiresAt: row.expires_at, updatedAt: row.updated_at
  };
}

function mapPosBarcode(row) {
  return {
    id: row.id, itemId: row.item_id, unitId: row.unit_id, barcode: row.barcode,
    item: { id: row.item_id, sku: row.sku, name: row.item_name },
    conversionFactor: decimalString(decimal(row.conversion_factor)),
    salePrice: row.sale_price == null ? null : decimalString(decimal(row.sale_price)), currency: row.currency
  };
}

function mapDiscountPolicy(row) {
  return {
    id: row.id, companyId: row.company_id, deviceId: row.device_id,
    maxDiscountPercent: decimalString(decimal(row.max_discount_percent))
  };
}

function mapPosShift(row) {
  return {
    id: row.id, companyId: row.company_id, deviceId: row.device_id, openedBy: row.opened_by,
    closedBy: row.closed_by, status: row.status, openingFloat: decimalString(decimal(row.opening_float)),
    expectedCash: row.expected_cash == null ? null : decimalString(decimal(row.expected_cash)),
    countedCash: row.counted_cash == null ? null : decimalString(decimal(row.counted_cash)),
    variance: row.variance == null ? null : decimalString(decimal(row.variance)),
    openedAt: row.opened_at, closeSubmittedAt: row.close_submitted_at, closedAt: row.closed_at,
    openOperationId: row.open_operation_id, closeOperationId: row.close_operation_id
  };
}

function mapReceipt(row) {
  return {
    id: row.id, companyId: row.company_id, documentId: row.document_id, shiftId: row.shift_id,
    receiptNumber: row.receipt_number, printCount: row.print_count, payload: row.receipt_payload, createdAt: row.created_at
  };
}

function mapRepresentative(row){return{id:row.id,companyId:row.company_id,userId:row.user_id,vehicleWarehouseId:row.vehicle_warehouse_id,code:row.code,name:row.name,deviceId:row.device_id,active:row.active};}
function mapRepresentativeCustomer(row){return{companyId:row.company_id,representativeId:row.representative_id,customerId:row.customer_id,visitOrder:row.visit_order,creditLimit:row.credit_limit==null?null:decimalString(decimal(row.credit_limit)),active:row.active};}
function mapRepresentativeRoute(row){return{id:row.id,companyId:row.company_id,representativeId:row.representative_id,code:row.code,name:row.name,routeDate:row.route_date,active:row.active};}
function mapRepresentativeOrder(row){return{id:row.id,companyId:row.company_id,representativeId:row.representative_id,customerId:row.customer_id,orderNumber:row.order_number,currency:row.currency,total:decimalString(decimal(row.total)),status:row.status,saleDocumentId:row.sale_document_id,operationId:row.operation_id,occurredAt:row.occurred_at};}
function mapRepresentativeHandover(row){return{id:row.id,companyId:row.company_id,representativeId:row.representative_id,destinationWarehouseId:row.destination_warehouse_id,handoverNumber:row.handover_number,expectedCash:decimalString(decimal(row.expected_cash)),submittedCash:decimalString(decimal(row.submitted_cash)),reviewedCash:row.reviewed_cash==null?null:decimalString(decimal(row.reviewed_cash)),cashVariance:row.cash_variance==null?null:decimalString(decimal(row.cash_variance)),currency:row.currency,status:row.status,submittedAt:row.submitted_at,reviewedAt:row.reviewed_at};}
function mapConflict(row){return{id:row.id,operationId:row.operation_id,deviceId:row.device_id,code:row.code,message:row.message,createdAt:row.created_at};}
