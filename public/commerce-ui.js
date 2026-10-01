(function () {
  'use strict';

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'تعذر تنفيذ العملية');
    return data;
  }

  async function masterData() {
    return api('/api/v1/master-data');
  }

  async function waitForOffline() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (window.AlMahasibOffline) return window.AlMahasibOffline;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('لم يكتمل تجهيز التخزين المحلي');
  }

  async function ensureBasics(master) {
    let unit = master.units.find((row) => row.code.toUpperCase() === 'PC');
    if (!unit) unit = (await api('/api/v1/catalog/units', { method: 'POST', body: JSON.stringify({ code: 'PC', name: 'قطعة', decimalPlaces: 3 }) })).unit;
    let warehouse = master.warehouses.find((row) => row.code.toUpperCase() === 'MAIN');
    if (!warehouse) warehouse = (await api('/api/v1/warehouses', { method: 'POST', body: JSON.stringify({ code: 'MAIN', name: 'المخزن الرئيسي', kind: 'standard' }) })).warehouse;
    return { unit, warehouse };
  }

  async function saveInventoryRow(button) {
    if (!navigator.onLine) throw new Error('إضافة تعريف مادة جديدة تتطلب اتصالًا أوليًا');
    const row = button.closest('tr');
    const inputs = row.querySelectorAll('input');
    const sku = inputs[0].value.trim();
    const name = inputs[1].value.trim();
    const quantity = normalizeDecimal(inputs[3].value || '0');
    if (!sku || !name) throw new Error('أدخل رمز المادة واسمها');
    const basics = await ensureBasics(await masterData());
    const item = (await api('/api/v1/catalog/items', {
      method: 'POST', body: JSON.stringify({ sku, name, baseUnitId: basics.unit.id })
    })).item;
    if (toScaled(quantity) > 0n) {
      const offline = await waitForOffline();
      await offline.enqueue('commerce.commit', {
        documentType: 'purchase', documentNumber: `OPEN-${crypto.randomUUID().slice(0, 8)}`,
        warehouseId: basics.warehouse.id, partyId: null, originalDocumentId: null, currency: 'IQD',
        lines: [{ itemId: item.id, unitId: basics.unit.id, originalLineId: null, quantity, unitPrice: '0.000000' }], payments: []
      });
    }
    return item;
  }

  async function saveSale() {
    try {
      const modal = document.getElementById('addSaleModal');
      const inputs = modal.querySelectorAll('input');
      const [customerText, itemText] = [inputs[0].value.trim(), inputs[1].value.trim()];
      const quantity = normalizeDecimal(inputs[2].value || '0');
      const total = normalizeDecimal(inputs[3].value || '0');
      const master = await masterData();
      const customer = master.customers.find((row) => row.name === customerText || row.code === customerText);
      const item = master.items.find((row) => row.name === itemText || row.sku === itemText);
      const warehouse = master.warehouses[0];
      if (!customer || !item || !warehouse) throw new Error('اختر عميلًا ومادة ومخزنًا معرفين مسبقًا');
      const baseUnit = item.units.find((unit) => unit.isBase);
      const unitPrice = divideDecimal(total, quantity);
      const offline = await waitForOffline();
      await offline.enqueue('commerce.commit', {
        documentType: 'sale', documentNumber: `SALE-${Date.now()}`, warehouseId: warehouse.id,
        partyId: customer.id, originalDocumentId: null, currency: 'IQD',
        lines: [{ itemId: item.id, unitId: baseUnit.unitId, originalLineId: null, quantity, unitPrice }],
        payments: [{ method: 'cash', amount: total, reference: null }]
      });
      closeModal('addSaleModal');
      alert('✅ حُفظ البيع محليًا وسيُزامن تلقائيًا.');
    } catch (error) {
      alert(error.message);
    }
  }

  async function saveCustomer() {
    try {
      if (!navigator.onLine) throw new Error('إضافة عميل جديد تتطلب اتصالًا أوليًا');
      const modal = document.getElementById('addClientModal');
      const inputs = modal.querySelectorAll('input');
      const name = inputs[0].value.trim();
      if (!name) throw new Error('أدخل اسم العميل');
      await api('/api/v1/customers', {
        method: 'POST', body: JSON.stringify({ code: `C-${Date.now()}`, name, phone: inputs[1].value.trim(), creditLimit: '0.000000' })
      });
      closeModal('addClientModal');
      alert('✅ تم حفظ العميل.');
    } catch (error) {
      alert(error.message);
    }
  }

  function toScaled(value) {
    const [whole, fraction = ''] = String(value).split('.');
    return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  }

  function fromScaled(value) {
    return `${value / 1000000n}.${String(value % 1000000n).padStart(6, '0')}`;
  }

  function normalizeDecimal(value) {
    const text = String(value).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error('أدخل قيمة موجبة بدقة لا تتجاوز 6 منازل');
    const result = fromScaled(toScaled(text));
    if (toScaled(result) < 0n) throw new Error('القيمة السالبة غير مسموحة');
    return result;
  }

  function divideDecimal(total, quantity) {
    const divisor = toScaled(quantity);
    if (divisor <= 0n) throw new Error('الكمية يجب أن تكون أكبر من صفر');
    return fromScaled((toScaled(total) * 1000000n + divisor / 2n) / divisor);
  }

  window.AlMahasibCommerce = { saveInventoryRow, saveSale, saveCustomer };
}());

