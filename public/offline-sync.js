(function () {
  'use strict';

  let database;
  let account;
  let syncing = false;

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error?.message || 'تعذر الاتصال بالخادم');
      error.code = data?.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function openDatabase(context) {
    const name = `almahasib-${context.company.id}-${context.user.id}`;
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        const outbox = db.createObjectStore('outbox', { keyPath: 'operationId' });
        outbox.createIndex('state_sequence', ['state', 'clientSequence']);
        db.createObjectStore('changes', { keyPath: ['entityType', 'entityId'] });
        db.createObjectStore('metadata', { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  function transaction(storeNames, mode, callback) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeNames, mode);
      const result = callback(tx);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('تم إلغاء العملية المحلية'));
    });
  }

  function readRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function enqueue(type, payload, options = {}) {
    if (!database || !account) throw new Error('لم تكتمل تهيئة الحساب');
    const nextSequence = (await getMetadata('nextSequence')) || 1;
    const operation = {
      operationId: crypto.randomUUID(),
      deviceId: deviceId(),
      clientSequence: nextSequence,
      schemaVersion: 1,
      entityVersion: options.entityVersion ?? null,
      dependencies: options.dependencies || [],
      occurredAt: new Date().toISOString(),
      type,
      payload,
      state: 'pending',
      attempts: 0,
      localReservations: options.localReservations || []
    };
    let nextPosState;
    let nextRepresentativeState;
    if (options.posState) nextPosState = options.posState;
    if (options.representativeState) nextRepresentativeState = options.representativeState;
    if (options.representativeStateBefore) operation.representativeStateBefore = options.representativeStateBefore;
    await transaction(['outbox', 'metadata'], 'readwrite', (tx) => {
      tx.objectStore('outbox').add(operation);
      tx.objectStore('metadata').put({ key: 'nextSequence', value: nextSequence + 1 });
      if (nextPosState) tx.objectStore('metadata').put({ key: 'posState', value: nextPosState });
      if (nextRepresentativeState) tx.objectStore('metadata').put({ key: 'representativeState', value: nextRepresentativeState });
    });
    if (navigator.onLine) void synchronize();
    return operation;
  }

  async function synchronize() {
    if (!database || !navigator.onLine || syncing) return;
    const run = async () => {
      syncing = true;
      try {
        await pushPending();
        await pullChanges();
        await refreshPosAfterSync();
        await refreshRepresentativeAfterSync();
        await setMetadata('lastSuccessfulSync', new Date().toISOString());
        window.dispatchEvent(new CustomEvent('almahasib:sync', { detail: { state: 'complete' } }));
      } catch (error) {
        window.dispatchEvent(new CustomEvent('almahasib:sync', { detail: { state: 'failed', error } }));
      } finally {
        syncing = false;
      }
    };
    if (navigator.locks) return navigator.locks.request(`almahasib-sync-${account.company.id}-${account.user.id}`, run);
    return run();
  }

  async function pushPending() {
    const operations = await readRequest(database.transaction('outbox').objectStore('outbox').getAll());
    const pending = operations.filter((operation) => ['pending', 'retry', 'sending'].includes(operation.state))
      .sort((a, b) => a.clientSequence - b.clientSequence).slice(0, 100);
    if (!pending.length) return;
    await updateStates(pending, 'sending');
    try {
      const body = { operations: pending.map(({ state, attempts, lastError, localReservations, representativeStateBefore, serverResult, acknowledgedAt, ...operation }) => operation) };
      const data = await request('/api/v1/sync/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const posState = await getMetadata('posState');
      let representativeState = await getMetadata('representativeState');
      data.results.forEach((result) => {
        const original = pending.find((operation) => operation.operationId === result.operationId);
        if (!original || !posState) return;
        if (result.status === 'rejected') restoreReservations(posState, original.localReservations || []);
        if (result.status === 'rejected' && original.type === 'pos.shift.open') posState.shift = null;
        if (result.status === 'rejected' && original.type === 'pos.shift.close' && posState.shift) posState.shift.status = 'open';
        if (result.shift) posState.shift = result.shift;
        if (result.receipt) posState.lastReceipt = result.receipt;
        if (result.status === 'rejected' && original.representativeStateBefore) representativeState = original.representativeStateBefore;
      });
      await transaction(['outbox', 'metadata'], 'readwrite', (tx) => {
        const store = tx.objectStore('outbox');
        data.results.forEach((result) => {
          const original = pending.find((operation) => operation.operationId === result.operationId);
          store.put({ ...original, state: result.status, serverResult: result, acknowledgedAt: new Date().toISOString() });
        });
        if (posState) tx.objectStore('metadata').put({ key: 'posState', value: posState });
        if (representativeState) tx.objectStore('metadata').put({ key: 'representativeState', value: representativeState });
      });
    } catch (error) {
      await transaction('outbox', 'readwrite', (tx) => {
        const store = tx.objectStore('outbox');
        pending.forEach((operation) => store.put({ ...operation, state: 'retry', attempts: operation.attempts + 1, lastError: error.code || 'NETWORK' }));
      });
      throw error;
    }
  }

  async function pullChanges() {
    let cursor = (await getMetadata('cursor')) || 0;
    let hasMore = true;
    while (hasMore) {
      const page = await request(`/api/v1/sync/pull?cursor=${encodeURIComponent(cursor)}`);
      await transaction(['changes', 'metadata'], 'readwrite', (tx) => {
        const changes = tx.objectStore('changes');
        page.changes.forEach((change) => changes.put(change));
        tx.objectStore('metadata').put({ key: 'cursor', value: page.nextCursor });
      });
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }
  }

  async function updateStates(operations, state) {
    await transaction('outbox', 'readwrite', (tx) => {
      const store = tx.objectStore('outbox');
      operations.forEach((operation) => store.put({ ...operation, state }));
    });
  }

  async function getMetadata(key) {
    const row = await readRequest(database.transaction('metadata').objectStore('metadata').get(key));
    return row?.value;
  }

  async function setMetadata(key, value) {
    await transaction('metadata', 'readwrite', (tx) => tx.objectStore('metadata').put({ key, value }));
  }

  function deviceId() {
    let id = localStorage.getItem('almahasib_device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('almahasib_device_id', id);
    }
    return id;
  }

  async function initializePos(mode) {
    const id = posDeviceId(mode);
    const snapshot = await request(`/api/v1/pos/bootstrap?deviceId=${encodeURIComponent(id)}`);
    const state = { ...snapshot, deviceId: id, refreshedAt: new Date().toISOString() };
    await setMetadata('posState', state);
    return state;
  }

  function posDeviceId(mode) {
    const key = `almahasib_pos_device_${mode || 'default'}`;
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }

  async function refreshPosAfterSync() {
    const existing = await getMetadata('posState');
    if (!existing?.deviceId) return;
    const snapshot = await request(`/api/v1/pos/bootstrap?deviceId=${encodeURIComponent(existing.deviceId)}`);
    await setMetadata('posState', {
      ...snapshot, deviceId: existing.deviceId, lastReceipt: existing.lastReceipt,
      refreshedAt: new Date().toISOString()
    });
  }

  async function getPosState() {
    return getMetadata('posState');
  }

  async function initializeRepresentative(representativeId) {
    const query = representativeId ? `?representativeId=${encodeURIComponent(representativeId)}` : '';
    const snapshot = await request(`/api/v1/representatives/bootstrap${query}`);
    const master = await request('/api/v1/master-data');
    const commerce = await request('/api/v1/commerce/documents');
    const state = { ...snapshot, warehouses: master.warehouses || snapshot.warehouses || [], documents: (commerce.documents || []).filter((row) => row.representativeId === snapshot.representative.id), refreshedAt: new Date().toISOString() };
    await setMetadata('representativeState', state);
    return state;
  }

  async function refreshRepresentativeAfterSync() {
    const existing = await getMetadata('representativeState');
    if (!existing?.representative?.id) return;
    const snapshot = await request(`/api/v1/representatives/bootstrap?representativeId=${encodeURIComponent(existing.representative.id)}`);
    const master = await request('/api/v1/master-data');
    const commerce = await request('/api/v1/commerce/documents');
    await setMetadata('representativeState', { ...snapshot, warehouses: master.warehouses || existing.warehouses || [], documents: (commerce.documents || []).filter((row) => row.representativeId === snapshot.representative.id), refreshedAt: new Date().toISOString() });
  }

  async function getRepresentativeState() { return getMetadata('representativeState'); }

  async function enqueueRepresentativeOperation(type, payload) {
    const current = await getRepresentativeState();
    if (!current?.representative) throw new Error('لم تُنزّل بيانات المندوب على هذا الجهاز');
    const before = structuredClone(current);
    if (payload.representativeId !== current.representative.id) throw new Error('العملية لا تخص المندوب المسجل على الجهاز');
    if (type === 'representative.sale') {
      if ((current.handovers || []).some((row) => ['submitted', 'submitted_pending_sync'].includes(row.status))) throw new Error('توجد عهدة مسلمة بانتظار مراجعة المشرف');
      const customer = current.customers.find((row) => row.id === payload.partyId);
      if (!customer) throw new Error('العميل غير مسند لهذا المندوب');
      let total = 0n;
      for (const line of payload.lines) {
        const relation = current.catalog?.find((row) => row.itemId === line.itemId && row.unitId === line.unitId);
        const stock = current.stock.find((row) => row.itemId === line.itemId);
        if (!relation || !stock) throw new Error('المادة غير متاحة في مخزن السيارة');
        const baseQuantity = multiplyDecimal(line.quantity, relation.conversionFactor);
        if (toScaled(stock.quantity) < toScaled(baseQuantity)) throw new Error('الكمية تتجاوز مخزون السيارة المحلي');
        stock.quantity = fromScaled(toScaled(stock.quantity) - toScaled(baseQuantity));
        total += toScaled(multiplyDecimal(line.quantity, line.unitPrice));
      }
      total -= toScaled(payload.discountAmount || '0');
      const paid = (payload.payments || []).reduce((sum, row) => sum + toScaled(row.amount), 0n);
      const due = total - paid;
      const limit = toScaled(customer.assignment.creditLimit ?? customer.creditLimit ?? '0');
      if (toScaled(customer.debt) + due > limit) throw new Error('البيع يتجاوز حد ائتمان العميل المحلي');
      customer.debt = fromScaled(toScaled(customer.debt) + due);
      current.custody = fromScaled(toScaled(current.custody) + paid);
    } else if (type === 'representative.return') {
      const original = current.documents?.find((row) => row.id === payload.originalDocumentId && row.documentType === 'sale');
      if (!original) throw new Error('الفاتورة الأصلية غير متاحة ضمن البيانات المحملة');
      const paid = (payload.payments || []).reduce((sum, row) => sum + toScaled(row.amount), 0n);
      if (paid > toScaled(current.custody)) throw new Error('نقد المرتجع يتجاوز عهدة المندوب المحلية');
      for (const line of payload.lines) { const originalLine=original.lines.find(x=>x.id===line.originalLineId); const stock=current.stock.find(x=>x.itemId===line.itemId); if(!originalLine||!stock) throw new Error('بند المرتجع غير متاح محليًا'); const base=multiplyDecimal(line.quantity,originalLine.conversionFactor); stock.quantity=fromScaled(toScaled(stock.quantity)+toScaled(base)); }
      const customer=current.customers.find(row=>row.id===payload.partyId); const gross=payload.lines.reduce((sum,line)=>{const originalLine=original.lines.find(x=>x.id===line.originalLineId);return sum+toScaled(multiplyDecimal(line.quantity,originalLine.unitPrice))},0n); const due=gross-paid; if(customer)customer.debt=fromScaled(toScaled(customer.debt)>due?toScaled(customer.debt)-due:0n); current.custody=fromScaled(toScaled(current.custody)-paid);
    } else if (type === 'representative.collection') {
      const customer = current.customers.find((row) => row.id === payload.customerId);
      if (!customer || toScaled(payload.amount) > toScaled(customer.debt)) throw new Error('التحصيل يتجاوز دين العميل المحلي');
      customer.debt = fromScaled(toScaled(customer.debt) - toScaled(payload.amount));
      current.custody = fromScaled(toScaled(current.custody) + toScaled(payload.amount));
    } else if (type === 'representative.handover.submit') {
      if ((current.handovers || []).some((row) => ['submitted', 'submitted_pending_sync'].includes(row.status))) throw new Error('يوجد تسليم سابق بانتظار المراجعة');
      for (const line of payload.lines || []) { const stock = current.stock.find((row) => row.itemId === line.itemId); if (!stock || toScaled(stock.quantity) < toScaled(line.quantity)) throw new Error('بضاعة السيارة لا تكفي للتسليم'); }
      current.handovers.unshift({ id: payload.handoverId, handoverNumber: payload.handoverNumber, submittedCash: payload.submittedCash, expectedCash: current.custody, status: 'submitted_pending_sync' });
    }
    return enqueue(type, payload, { representativeState: current, representativeStateBefore: before });
  }

  async function queueStatus() {
    const rows = await readRequest(database.transaction('outbox').objectStore('outbox').getAll());
    return { pending: rows.filter((row) => ['pending', 'retry', 'sending'].includes(row.state)), conflicts: rows.filter((row) => row.state === 'rejected') };
  }

  async function openPosShift(openingFloat) {
    const state = await requirePosState();
    if (state.shift && state.shift.status !== 'closed') throw new Error('يوجد شفت مفتوح أو بانتظار الإغلاق');
    const shiftId = crypto.randomUUID();
    const localShift = { id: shiftId, deviceId: state.deviceId, status: 'open', openingFloat, openedAt: new Date().toISOString() };
    state.shift = localShift;
    return enqueue('pos.shift.open', { shiftId, deviceId: state.deviceId, openingFloat }, { posState: state });
  }

  async function enqueuePosDocument(type, payload) {
    const state = await requirePosState();
    if (!state.shift || state.shift.status !== 'open') throw new Error('افتح الشفت أولًا');
    const isReturn = type === 'pos.return';
    const offlineOrigin = !navigator.onLine;
    const reservations = [];
    for (const line of payload.lines) {
      const barcode = state.barcodes.find((entry) => entry.itemId === line.itemId && entry.unitId === line.unitId);
      if (!barcode) throw new Error('المادة غير متاحة على هذا الجهاز');
      const allocation = state.allocations.find((entry) => entry.itemId === line.itemId);
      if (!allocation && offlineOrigin) throw new Error('لا يوجد مخصص أوف لاين للمادة');
      if (!allocation) continue;
      const baseQuantity = multiplyDecimal(line.quantity, barcode.conversionFactor);
      const available = toScaled(allocation.allocatedQuantity) - toScaled(allocation.consumedQuantity);
      if (!isReturn && available < toScaled(baseQuantity)) throw new Error('الكمية تتجاوز مخصص الجهاز أثناء الأوف لاين');
      const delta = isReturn ? -toScaled(baseQuantity) : toScaled(baseQuantity);
      allocation.consumedQuantity = fromScaled(maxBigInt(0n, toScaled(allocation.consumedQuantity) + delta));
      reservations.push({ itemId: line.itemId, delta: fromScaled(delta) });
    }
    return enqueue(type, {
      ...payload, shiftId: state.shift.id, deviceId: state.deviceId,
      interfaceMode: state.device.interfaceMode, offlineOrigin
    }, { posState: state, localReservations: reservations });
  }

  async function closePosShift(countedCash) {
    const state = await requirePosState();
    if (!state.shift || state.shift.status !== 'open') throw new Error('لا يوجد شفت مفتوح');
    state.shift.status = 'submitted_pending_sync';
    state.shift.countedCash = countedCash;
    return enqueue('pos.shift.close', {
      shiftId: state.shift.id, deviceId: state.deviceId, countedCash,
      submittedOffline: !navigator.onLine
    }, { posState: state });
  }

  async function requirePosState() {
    const state = await getPosState();
    if (!state?.device) throw new Error('لم يُسجل جهاز الكاشير أو لم تُنزّل بياناته');
    return structuredClone(state);
  }

  function restoreReservations(state, reservations) {
    for (const reservation of reservations) {
      const allocation = state.allocations?.find((entry) => entry.itemId === reservation.itemId);
      if (!allocation) continue;
      allocation.consumedQuantity = fromScaled(maxBigInt(0n, toScaled(allocation.consumedQuantity) - toScaled(reservation.delta)));
    }
  }

  function toScaled(value) {
    const text = String(value);
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    return negative ? -result : result;
  }

  function fromScaled(value) {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    return `${negative ? '-' : ''}${absolute / 1000000n}.${String(absolute % 1000000n).padStart(6, '0')}`;
  }

  function multiplyDecimal(left, right) {
    return fromScaled((toScaled(left) * toScaled(right) + 500000n) / 1000000n);
  }

  function maxBigInt(left, right) { return left > right ? left : right; }

  async function initialize() {
    try {
      try {
        account = await request('/api/v1/bootstrap');
        localStorage.setItem('almahasib_cached_bootstrap', JSON.stringify(account));
      } catch (error) {
        const cached = localStorage.getItem('almahasib_cached_bootstrap');
        if (navigator.onLine || !cached || error.status === 401) throw error;
        account = JSON.parse(cached);
        if (!account.offlineSessionExpiresAt || Date.parse(account.offlineSessionExpiresAt) <= Date.now()) throw error;
      }
      database = await openDatabase(account);
      window.AlMahasibOffline = {
        enqueue, synchronize, account: () => account, initializePos, getPosState,
        openPosShift, enqueuePosDocument, closePosShift, deviceId, posDeviceId
        , initializeRepresentative, getRepresentativeState, enqueueRepresentativeOperation, queueStatus
      };
      if (navigator.onLine) await synchronize();
    } catch (error) {
      if (error.status === 401 && location.pathname !== '/' && !location.pathname.endsWith('/index.html')) {
        location.replace('/');
      }
    }
  }

  window.addEventListener('online', synchronize);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void synchronize(); });
  void initialize();
}());
