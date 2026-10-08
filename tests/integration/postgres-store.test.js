import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, hashToken, newSessionToken, payloadHash } from '../../apps/api/src/lib/security.js';
import { PostgresStore } from '../../apps/api/src/store/postgres-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL store executes the foundation workflow and protects financial rows', { skip: !databaseUrl }, async () => {
  const store = new PostgresStore(databaseUrl);
  const companyCode = `pg_${Date.now().toString(36)}`;
  try {
    const platform = await store.seedPlatformAdmin({
      username: 'platform_test', passwordHash: await hashPassword('Platform-Test-123'), displayName: 'Platform Test'
    });
    const company = await store.registerCompany({
      code: companyCode, legalName: 'PostgreSQL Test Company', timezone: 'Asia/Baghdad', currency: 'IQD',
      owner: { username: 'admin', displayName: 'Admin', passwordHash: await hashPassword('Company-Test-123') }
    });
    const pending = await store.findLogin({ companyCode, username: 'admin', platform: false });
    assert.equal(pending.company.status, 'pending');
    await store.approveCompany(company.id, platform.id);
    const login = await store.findLogin({ companyCode, username: 'admin', platform: false });
    assert.equal(login.company.status, 'active');

    const token = newSessionToken();
    await store.createSession({ tokenHash: hashToken(token), userId: login.user.id, deviceId: 'postgres-test', expiresAt: new Date(Date.now() + 60000) });
    const context = await store.getSessionContext(hashToken(token));
    assert.equal(context.company.id, company.id);
    assert.ok(context.permissions.includes('company.manage'));
    await store.touchSession(hashToken(token));
    const onlineSince = new Date(Date.now() - 90000).toISOString();
    assert.deepEqual(await store.listOnlineUserIds(company.id, onlineSince), [login.user.id]);
    assert.equal(await store.countOnlineUsers(company.id, onlineSince), 1);

    const operation = {
      operationId: crypto.randomUUID(), deviceId: 'postgres-test', clientSequence: 1,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(),
      type: 'financial.record', payload: { kind: 'test_receipt', amount: '100.000000', currency: 'IQD' }
    };
    operation.payloadHash = payloadHash(operation.payload);
    const first = await store.pushOperations(context, [operation]);
    const replay = await store.pushOperations(context, [operation]);
    assert.equal(first[0].entityId, replay[0].entityId);

    await assert.rejects(
      store.pool.query(`DELETE FROM financial_records WHERE id = $1`, [first[0].entityId]),
      /immutable financial or audit record/
    );
    const rls = await store.pool.query(
      `SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS protected
       FROM pg_class WHERE relname IN ('users', 'sync_operations', 'financial_records', 'journal_entries')`
    );
    assert.equal(rls.rows[0].protected, true);

    const piece = await store.createUnit(company.id, { code: 'PC', name: 'Piece', decimalPlaces: 3 }, login.user.id);
    const box = await store.createUnit(company.id, { code: 'BOX', name: 'Box', decimalPlaces: 3 }, login.user.id);
    const item = await store.createItem(company.id, { sku: 'PG-ITEM', name: 'Postgres item', baseUnitId: piece.id }, login.user.id);
    await store.addItemUnit(company.id, item.id, { unitId: box.id, conversionFactor: '12.000000' }, login.user.id);
    const supplier = await store.createParty(company.id, 'supplier', { code: 'PG-SUP', name: 'Supplier' }, login.user.id);
    const customer = await store.createParty(company.id, 'customer', { code: 'PG-CUS', name: 'Customer', creditLimit: '1000.000000' }, login.user.id);
    const warehouse = await store.createWarehouse(company.id, { code: 'PG-WH', name: 'Warehouse', kind: 'standard' }, login.user.id);
    const otherCompany = await store.registerCompany({
      code: `${companyCode}_b`, legalName: 'Other tenant', timezone: 'Asia/Baghdad', currency: 'IQD',
      owner: { username: 'admin', displayName: 'Other Admin', passwordHash: await hashPassword('Other-Company-123') }
    });
    await store.approveCompany(otherCompany.id, platform.id);
    assert.equal((await store.listMasterData(otherCompany.id)).items.length, 0);
    await assert.rejects(
      store.createItem(otherCompany.id, { sku: 'CROSS-TENANT', name: 'Cross', baseUnitId: piece.id }, otherCompany.ownerUserId),
      (error) => error.code === 'RELATED_ENTITY_NOT_FOUND'
    );

    const commerceOperation = {
      operationId: crypto.randomUUID(), deviceId: 'postgres-test', clientSequence: 2,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(),
      type: 'commerce.commit',
      payload: {
        documentType: 'purchase', documentNumber: 'PG-PUR-001', warehouseId: warehouse.id,
        partyId: supplier.id, originalDocumentId: null, currency: 'IQD',
        lines: [{ itemId: item.id, unitId: box.id, originalLineId: null, quantity: '2.500000', unitPrice: '120.123456' }],
        payments: [{ method: 'cash', amount: '100.000000', reference: null }]
      }
    };
    commerceOperation.payloadHash = payloadHash(commerceOperation.payload);
    const purchase = await store.pushOperations(context, [commerceOperation]);
    assert.equal(purchase[0].status, 'acknowledged');
    assert.equal(purchase[0].document.subtotal, '300.308640');
    const purchaseReplay = await store.pushOperations(context, [commerceOperation]);
    assert.equal(purchaseReplay[0].entityId, purchase[0].entityId);
    let master = await store.listMasterData(company.id);
    assert.equal(master.stock[0].quantity, '30.000000');
    assert.equal(master.stock[0].averageCost, '10.010288');

    const beforeFailure = await store.pool.query(
      `SELECT (SELECT count(*) FROM commerce_documents) AS documents,
              (SELECT count(*) FROM journal_entries WHERE entry_number LIKE 'COM-%') AS journals,
              (SELECT count(*) FROM server_outbox) AS outbox`
    );
    const invalidPayment = {
      operationId: crypto.randomUUID(), deviceId: 'postgres-test', clientSequence: 3,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(), type: 'commerce.commit',
      payload: {
        documentType: 'sale', documentNumber: 'PG-SAL-FAIL', warehouseId: warehouse.id,
        partyId: customer.id, originalDocumentId: null, currency: 'IQD',
        lines: [{ itemId: item.id, unitId: piece.id, originalLineId: null, quantity: '1.000000', unitPrice: '15.333333' }],
        payments: [{ method: 'invalid', amount: '1.000000', reference: null }]
      }
    };
    invalidPayment.payloadHash = payloadHash(invalidPayment.payload);
    const rejected = await store.pushOperations(context, [invalidPayment]);
    assert.equal(rejected[0].code, 'INVALID_PAYMENT');
    const afterFailure = await store.pool.query(
      `SELECT (SELECT count(*) FROM commerce_documents) AS documents,
              (SELECT count(*) FROM journal_entries WHERE entry_number LIKE 'COM-%') AS journals,
              (SELECT count(*) FROM server_outbox) AS outbox`
    );
    assert.deepEqual(afterFailure.rows[0], beforeFailure.rows[0]);
    master = await store.listMasterData(company.id);
    assert.equal(master.stock[0].quantity, '30.000000');
    const rejectedReplay = await store.pushOperations(context, [invalidPayment]);
    assert.equal(rejectedReplay[0].code, 'INVALID_PAYMENT');

    const saleOperation = structuredClone(invalidPayment);
    saleOperation.operationId = crypto.randomUUID();
    saleOperation.clientSequence = 4;
    saleOperation.payload.documentNumber = 'PG-SAL-001';
    saleOperation.payload.payments = [{ method: 'cash', amount: '10.000000', reference: null }];
    saleOperation.payloadHash = payloadHash(saleOperation.payload);
    const sale = await store.pushOperations(context, [saleOperation]);
    assert.equal(sale[0].status, 'acknowledged');
    assert.equal(sale[0].document.subtotal, '15.333333');
    master = await store.listMasterData(company.id);
    assert.equal(master.stock[0].quantity, '29.000000');
    await assert.rejects(
      store.pool.query(`DELETE FROM commerce_documents WHERE id=$1`, [sale[0].entityId]),
      /posted commerce records are immutable/
    );

    await store.setBarcode(company.id, { itemId: item.id, unitId: piece.id, barcode: `PG${Date.now()}` }, login.user.id);
    const posDeviceId = crypto.randomUUID();
    await store.createPosDevice(company.id, {
      id: posDeviceId, warehouseId: warehouse.id, code: `PG-POS-${Date.now()}`, name: 'Postgres POS',
      interfaceMode: 'market', maxDiscountPercent: '5.000000'
    }, login.user.id);
    await store.setPosAllocation(company.id, posDeviceId, { itemId: item.id, quantity: '5.000000' }, login.user.id);
    const posBootstrap = await store.getPosBootstrap(company.id, posDeviceId);
    assert.equal(posBootstrap.device.interfaceMode, 'market');
    assert.equal(posBootstrap.barcodes.length, 1);
    const reservedStockSale = {
      operationId: crypto.randomUUID(), deviceId: 'pg-central-reserved', clientSequence: 1,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(), type: 'commerce.commit',
      payload: {
        documentType: 'sale', documentNumber: `PG-RESERVED-${Date.now()}`, warehouseId: warehouse.id,
        partyId: customer.id, originalDocumentId: null, currency: 'IQD',
        lines: [{ itemId: item.id, unitId: piece.id, originalLineId: null, quantity: '25.000000', unitPrice: '10.000000' }],
        payments: [], discountAmount: '0.000000'
      }
    };
    reservedStockSale.payloadHash = payloadHash(reservedStockSale.payload);
    const reservedRejected = await store.pushOperations(context, [reservedStockSale]);
    assert.equal(reservedRejected[0].code, 'STOCK_RESERVED_FOR_OFFLINE');
    const shiftId = crypto.randomUUID();
    const openOperation = {
      operationId: crypto.randomUUID(), deviceId: posDeviceId, clientSequence: 1,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(),
      type: 'pos.shift.open', payload: { shiftId, deviceId: posDeviceId, openingFloat: '50.000000' }
    };
    openOperation.payloadHash = payloadHash(openOperation.payload);
    const opened = await store.pushOperations(context, [openOperation]);
    assert.equal(opened[0].shift.status, 'open');
    const posSaleOperation = {
      operationId: crypto.randomUUID(), deviceId: posDeviceId, clientSequence: 2,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(), type: 'pos.sale',
      payload: {
        shiftId, deviceId: posDeviceId, interfaceMode: 'market', documentNumber: `PG-POS-SALE-${Date.now()}`,
        currency: 'IQD', partyId: null, originalDocumentId: null,
        lines: [{ itemId: item.id, unitId: piece.id, originalLineId: null, quantity: '1.000000', unitPrice: '10.000000' }],
        payments: [{ method: 'cash', amount: '10.000000', reference: null }], discountAmount: '0.000000',
        orderContext: { lane: '1' }, offlineOrigin: true
      }
    };
    posSaleOperation.payloadHash = payloadHash(posSaleOperation.payload);
    const posSale = await store.pushOperations(context, [posSaleOperation]);
    assert.equal(posSale[0].status, 'acknowledged');
    assert.ok(posSale[0].receipt.receiptNumber.startsWith('RCP-'));
    const closeOperation = {
      operationId: crypto.randomUUID(), deviceId: posDeviceId, clientSequence: 3,
      schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(),
      type: 'pos.shift.close', payload: { shiftId, deviceId: posDeviceId, countedCash: '60.000000', submittedOffline: true }
    };
    closeOperation.payloadHash = payloadHash(closeOperation.payload);
    const closed = await store.pushOperations(context, [closeOperation]);
    assert.equal(closed[0].shift.status, 'closed');
    assert.equal(closed[0].shift.expectedCash, '60.000000');
    assert.equal(closed[0].shift.variance, '0.000000');

    const representativeUser = await store.createUser(company.id, {
      username: `pg_rep_${Date.now()}`, displayName: 'PG Representative', passwordHash: await hashPassword('PG-Representative-123'), roleCode: 'representative'
    }, login.user.id);
    const vehicle = await store.createWarehouse(company.id, { code: `CAR-${Date.now()}`, name: 'Vehicle', kind: 'vehicle' }, login.user.id);
    const representative = await store.createRepresentative(company.id, { userId: representativeUser.id, vehicleWarehouseId: vehicle.id, code: `REP-${Date.now()}`, name: 'PG Rep', deviceId: 'pg-rep-phone' }, login.user.id);
    await store.assignRepresentativeCustomer(company.id, representative.id, { customerId: customer.id, visitOrder: 1, creditLimit: '1000.000000' }, login.user.id);
    await store.createRepresentativeRoute(company.id, representative.id, { code: `ROUTE-${Date.now()}`, name: 'PG Route', routeDate: null, stops: [{ customerId: customer.id, stopOrder: 1, note: null }] }, login.user.id);
    let representativeSequence = 1;
    const representativeOperation = (type, payload) => { const value = { operationId: crypto.randomUUID(), deviceId: 'pg-rep-phone', clientSequence: representativeSequence++, schemaVersion: 1, entityVersion: null, dependencies: [], occurredAt: new Date().toISOString(), type, payload: { representativeId: representative.id, ...payload } }; value.payloadHash = payloadHash(value.payload); return value; };
    const load = representativeOperation('representative.load', { sourceWarehouseId: warehouse.id, transferNumber: `LOAD-${Date.now()}`, lines: [{ itemId: item.id, quantity: '5.000000' }] });
    assert.equal((await store.pushOperations(context, [load]))[0].status, 'acknowledged');
    const representativeSale = representativeOperation('representative.sale', { partyId: customer.id, documentNumber: `REP-SALE-${Date.now()}`, currency: 'IQD', originalDocumentId: null, lines: [{ itemId: item.id, unitId: piece.id, originalLineId: null, quantity: '2.000000', unitPrice: '10.000000' }], payments: [{ method: 'cash', amount: '5.000000', reference: null }], discountAmount: '0.000000' });
    const representativeSaleResult = (await store.pushOperations(context, [representativeSale]))[0];
    assert.equal(representativeSaleResult.status, 'acknowledged', JSON.stringify(representativeSaleResult));
    assert.equal((await store.pushOperations(context, [representativeSale]))[0].entityId, representativeSaleResult.entityId);
    const collection = representativeOperation('representative.collection', { customerId: customer.id, receiptNumber: `COL-${Date.now()}`, amount: '5.000000', currency: 'IQD' });
    assert.equal((await store.pushOperations(context, [collection]))[0].status, 'acknowledged');
    const handoverId = crypto.randomUUID();
    const submitted = representativeOperation('representative.handover.submit', { handoverId, destinationWarehouseId: warehouse.id, handoverNumber: `HND-${Date.now()}`, submittedCash: '10.000000', currency: 'IQD', lines: [{ itemId: item.id, quantity: '1.000000' }] });
    assert.equal((await store.pushOperations(context, [submitted]))[0].handover.status, 'submitted');
    const reviewed = representativeOperation('representative.handover.review', { handoverId, reviewedCash: '10.000000' });
    assert.equal((await store.pushOperations(context, [reviewed]))[0].handover.status, 'reviewed');
    const representativeSnapshot = await store.getRepresentativeBootstrap(context, representative.id);
    assert.equal(representativeSnapshot.stock[0].quantity, '2.000000');
    assert.equal(representativeSnapshot.custody, '0.000000');
    assert.equal(representativeSnapshot.customers[0].debt, '15.333333');
    const accounting = await store.pool.query(`SELECT count(*) FILTER (WHERE jl.account_code='4100-SALES') sales_lines, count(*) FILTER (WHERE jl.account_code='1150-REP-CASH-CUSTODY') custody_lines FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.company_id=$1 AND je.entry_number LIKE ANY(ARRAY['COM-sale-REP-SALE-%','COL-%','HND-%'])`, [company.id]);
    assert.equal(Number(accounting.rows[0].sales_lines), 1);
    assert.ok(Number(accounting.rows[0].custody_lines) >= 3);
    const representativeRls = await store.pool.query(`SELECT count(*) count, bool_and(relrowsecurity AND relforcerowsecurity) protected FROM pg_class WHERE relname IN ('representatives','representative_customers','representative_routes','stock_transfers','representative_orders','customer_debt_movements','representative_collections','representative_custody_movements','representative_handovers','sync_conflicts')`);
    assert.equal(Number(representativeRls.rows[0].count), 10);
    assert.equal(representativeRls.rows[0].protected, true);
  } finally {
    await store.close();
  }
});
