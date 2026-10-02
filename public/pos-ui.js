(function () {
  'use strict';

  const mode = new URLSearchParams(location.search).get('mode');
  const validModes = ['restaurant', 'market', 'enterprise'];
  const selectedMode = validModes.includes(mode) ? mode : 'market';
  const titles = { restaurant: 'المطاعم والكافيهات', market: 'الماركتات', enterprise: 'الشركات والمؤسسات' };
  const contexts = {
    restaurant: ['الطاولة / نوع الطلب', 'مثال: طاولة 4 أو سفري'],
    market: ['مسار الكاشير', 'مثال: صندوق 1'],
    enterprise: ['مرجع المشروع / الطلب', 'مثال: PO-102']
  };
  let offline;
  let state;
  let master;
  let cart = [];
  let localReceipt;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || 'تعذر تنفيذ العملية');
      error.code = data.error?.code;
      throw error;
    }
    return data;
  }

  async function initialize() {
    document.getElementById('modeTitle').textContent = titles[selectedMode];
    document.getElementById('contextLabel').textContent = contexts[selectedMode][0];
    document.getElementById('contextValue').placeholder = contexts[selectedMode][1];
    updateNetwork();
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    document.getElementById('barcodeInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); scanBarcode(); }
    });
    document.getElementById('discountInput').addEventListener('input', renderCart);
    for (let attempt = 0; attempt < 50 && !window.AlMahasibOffline; attempt += 1) await delay(100);
    offline = window.AlMahasibOffline;
    if (!offline) return alert('تعذر تجهيز التخزين المحلي');
    try {
      if (navigator.onLine) {
        try {
          state = await offline.initializePos(selectedMode);
        } catch (error) {
          if (error.code !== 'POS_DEVICE_NOT_FOUND') throw error;
          await registerDevice();
          state = await offline.initializePos(selectedMode);
        }
        master = await api('/api/v1/master-data');
        await ensureBarcodes();
        state = await offline.initializePos(selectedMode);
      } else {
        state = await offline.getPosState();
        if (!state || state.device?.interfaceMode !== selectedMode) throw new Error('هذه الواجهة لم تُجهز على الجهاز قبل انقطاع الإنترنت');
        master = { customers: state.customers || [] };
      }
      populateCustomers();
      renderRestaurantCatalog();
      restoreRestaurantCart();
      renderStatus();
    } catch (error) {
      alert(error.message);
      renderStatus();
    }
  }

  async function registerDevice() {
    master = await api('/api/v1/master-data');
    const warehouse = master.warehouses[0];
    if (!warehouse) throw new Error('أنشئ مخزنًا أولًا قبل تسجيل جهاز الكاشير');
    const id = offline.posDeviceId(selectedMode);
    await api('/api/v1/pos/devices', {
      method: 'POST',
      body: JSON.stringify({
        id, warehouseId: warehouse.id, code: `${selectedMode.slice(0, 3).toUpperCase()}-${id.slice(0, 6)}`,
        name: `كاشير ${titles[selectedMode]}`, interfaceMode: selectedMode, maxDiscountPercent: '5.000000'
      })
    });
  }

  async function ensureBarcodes() {
    const existing = new Set((state?.barcodes || []).map((entry) => entry.itemId));
    for (const item of master.items) {
      if (existing.has(item.id)) continue;
      const baseUnit = item.units.find((unit) => unit.isBase);
      try {
        await api('/api/v1/catalog/barcodes', {
          method: 'POST', body: JSON.stringify({ itemId: item.id, unitId: baseUnit.unitId, barcode: item.sku })
        });
      } catch (error) {
        if (error.code !== 'BARCODE_EXISTS') throw error;
      }
    }
  }

  async function allocateOffline() {
    try {
      if (!navigator.onLine) throw new Error('تعديل المخصص يتطلب اتصالًا');
      master = await api('/api/v1/master-data');
      const stocks = master.stock.filter((row) => row.warehouseId === state.device.warehouseId);
      if (!stocks.length) throw new Error('لا توجد أرصدة في مخزن الجهاز');
      for (const stock of stocks) {
        await api(`/api/v1/pos/devices/${state.deviceId}/allocations/${stock.itemId}`, {
          method: 'PUT', body: JSON.stringify({ quantity: stock.quantity })
        });
      }
      state = await offline.initializePos(selectedMode);
      alert('✅ حُدث مخصص الأوف لاين للجهاز.');
    } catch (error) { alert(error.message); }
  }

  async function openShift() {
    try {
      const opening = normalize(prompt('أدخل العهدة النقدية الافتتاحية:', '0') || '0');
      await offline.openPosShift(opening);
      state = await offline.getPosState();
      renderStatus();
      alert(navigator.onLine ? '✅ أُرسل فتح الشفت للاعتماد.' : '✅ حُفظ فتح الشفت محليًا وسيزامن تلقائيًا.');
    } catch (error) { alert(error.message); }
  }

  function renderRestaurantCatalog(){
    const el=document.getElementById('restaurantCatalog'); if(selectedMode!=='restaurant'||!el)return;
    el.style.display='grid';
    const bars=state?.barcodes||[];
    el.innerHTML=bars.map((b,i)=>'<div class="product-card" onclick="PosUI.addProduct('+i+')"><div class="product-photo">'+productEmoji(b.item?.name)+'</div><div class="product-info"><b>'+escapeHtml(b.item?.name||'مادة')+'</b><span class="product-price">'+escapeHtml(b.salePrice||'بدون سعر')+' IQD</span></div></div>').join('')||'<div>لا توجد مواد. أضف المواد والأسعار أولاً.</div>';
  }
  function productEmoji(name){const n=String(name||'').toLowerCase();if(/coffee|قهو|كابتش|لاتيه/.test(n))return '☕';if(/tea|شاي/.test(n))return '🍵';if(/juice|عصير/.test(n))return '🥤';if(/pizza|بيتزا/.test(n))return '🍕';if(/burger|برغر|برجر/.test(n))return '🍔';if(/cake|كيك/.test(n))return '🍰';return '🍽️'}
  function addProduct(index){const b=state?.barcodes?.[index];if(!b)return;const price=b.salePrice;if(!price)return alert('حدد سعر بيع لهذه المادة أولاً');const x=cart.find(l=>l.itemId===b.itemId&&l.unitId===b.unitId);if(x)x.quantity=fromScaled(toScaled(x.quantity)+1000000n);else cart.push({itemId:b.itemId,unitId:b.unitId,name:b.item.name,quantity:'1.000000',unitPrice:price});saveRestaurantCart();renderCart()}
  function changeQty(index,delta){const x=cart[index];if(!x)return;const q=toScaled(x.quantity)+BigInt(delta)*1000000n;if(q<=0n)cart.splice(index,1);else x.quantity=fromScaled(q);saveRestaurantCart();renderCart()}
  function saveRestaurantCart(){if(selectedMode==='restaurant')localStorage.setItem('almahasib_restaurant_open_order',JSON.stringify(cart))}
  function restoreRestaurantCart(){if(selectedMode!=='restaurant')return;try{const x=JSON.parse(localStorage.getItem('almahasib_restaurant_open_order')||'[]');if(Array.isArray(x))cart=x}catch{}renderCart()}
  function scanBarcode() {
    try {
      const input = document.getElementById('barcodeInput');
      const barcode = state?.barcodes?.find((entry) => entry.barcode === input.value.trim());
      if (!barcode) throw new Error('الباركود غير موجود ضمن بيانات الجهاز');
      const manual = document.getElementById('manualPrice').value;
      const price = barcode.salePrice || (manual ? normalize(manual) : null);
      if (!price) throw new Error('لا يوجد سعر بيع؛ أدخل سعرًا يدويًا');
      const existing = cart.find((line) => line.itemId === barcode.itemId && line.unitId === barcode.unitId);
      if (existing) existing.quantity = fromScaled(toScaled(existing.quantity) + 1000000n);
      else cart.push({ itemId: barcode.itemId, unitId: barcode.unitId, name: barcode.item.name, quantity: '1.000000', unitPrice: price });
      input.value = '';
      input.focus();
      saveRestaurantCart(); renderCart();
    } catch (error) { alert(error.message); }
  }

  function renderCart() {
    const body = document.getElementById('cartBody');
    if (!cart.length) body.innerHTML = '<tr><td colspan="5">لا توجد مواد</td></tr>';
    else body.innerHTML = cart.map((line, index) => `<tr><td>${escapeHtml(line.name)}</td><td><div class="qty"><button onclick="PosUI.changeQty(${index},-1)">−</button><b>${line.quantity}</b><button onclick="PosUI.changeQty(${index},1)">+</button></div></td><td>${line.unitPrice}</td><td>${multiply(line.quantity, line.unitPrice)}</td><td><button class="btn btn-danger" onclick="PosUI.remove(${index})">×</button></td></tr>`).join('');
    const discount = normalize(document.getElementById('discountInput').value || '0');
    const gross = cart.reduce((sum, line) => sum + toScaled(multiply(line.quantity, line.unitPrice)), 0n);
    const net = gross - toScaled(discount);
    document.getElementById('netTotal').textContent = fromScaled(net > 0n ? net : 0n);
  }

  function remove(index) { cart.splice(index, 1); saveRestaurantCart(); renderCart(); }

  async function completeSale() {
    try {
      if (!cart.length) throw new Error('أضف مادة واحدة على الأقل');
      state = await offline.getPosState();
      if (!state?.shift || state.shift.status !== 'open') throw new Error('افتح الشفت أولًا');
      const gross = cart.reduce((sum, line) => sum + toScaled(multiply(line.quantity, line.unitPrice)), 0n);
      const discount = normalize(document.getElementById('discountInput').value || '0');
      const net = fromScaled(gross - toScaled(discount));
      if (toScaled(net) < 0n) throw new Error('الخصم يتجاوز الإجمالي');
      const paymentMode = document.getElementById('paymentMode').value;
      const cash = paymentMode === 'cash' ? net : paymentMode === 'mixed' ? normalize(document.getElementById('cashAmount').value || '0') : '0.000000';
      if (toScaled(cash) > toScaled(net)) throw new Error('النقد يتجاوز صافي الفاتورة');
      const customerText = document.getElementById('customerInput').value.trim();
      const customer = master?.customers?.find((entry) => entry.code === customerText || entry.name === customerText);
      if (toScaled(cash) < toScaled(net) && !customer) throw new Error('اختر عميلًا للبيع الآجل أو المختلط');
      const orderContext = { mode: selectedMode, reference: document.getElementById('contextValue').value.trim() };
      const payload = {
        documentNumber: `POS-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, currency: 'IQD',
        partyId: customer?.id || null, originalDocumentId: null,
        lines: cart.map(({ name, ...line }) => ({ ...line, originalLineId: null })),
        payments: toScaled(cash) > 0n ? [{ method: 'cash', amount: cash, reference: null }] : [],
        discountAmount: discount, orderContext
      };
      await offline.enqueuePosDocument('pos.sale', payload);
      localReceipt = { number: payload.documentNumber, lines: structuredClone(cart), gross: fromScaled(gross), discount, net, cash, due: fromScaled(toScaled(net) - toScaled(cash)), mode: titles[selectedMode] };
      renderReceipt(localReceipt);
      cart = []; saveRestaurantCart(); renderCart();
      alert(navigator.onLine ? '✅ حُفظ البيع وأُرسل للمزامنة.' : '✅ حُفظ البيع أوف لاين ضمن مخصص الجهاز.');
    } catch (error) { alert(error.message); }
  }

  async function returnLast() {
    try {
      state = await offline.getPosState();
      const document = state?.lastReceipt?.payload?.document;
      if (!document) throw new Error('لا يوجد وصل خادمي متزامن لإرجاعه');
      const cashPaid = (document.payments || []).filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + toScaled(payment.amount), 0n);
      await offline.enqueuePosDocument('pos.return', {
        documentNumber: `RET-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, currency: document.currency,
        partyId: document.customerId, originalDocumentId: document.id,
        lines: document.lines.map((line) => ({ itemId: line.itemId, unitId: line.unitId, originalLineId: line.id, quantity: line.quantity })),
        payments: cashPaid > 0n ? [{ method: 'cash', amount: fromScaled(cashPaid), reference: document.documentNumber }] : [],
        discountAmount: '0.000000', orderContext: { mode: selectedMode, returnOf: document.documentNumber }
      });
      alert('✅ سُجل المرتجع وسيزامن تلقائيًا.');
    } catch (error) { alert(error.message); }
  }

  async function closeShift() {
    try {
      const counted = normalize(prompt('أدخل النقد الفعلي في الصندوق:', '0') || '0');
      await offline.closePosShift(counted);
      state = await offline.getPosState();
      renderStatus();
      alert(navigator.onLine ? '✅ أُرسل إغلاق الشفت للتسوية.' : '⏳ الإغلاق بانتظار المزامنة والاعتماد.');
    } catch (error) { alert(error.message); }
  }

  function printReceipt() {
    if (!localReceipt && state?.lastReceipt) renderReceipt(state.lastReceipt.payload.document);
    if (!document.getElementById('receipt').innerHTML) return alert('لا يوجد وصل للطباعة');
    window.print();
  }

  function renderReceipt(receipt) {
    document.getElementById('receipt').innerHTML = `<h2>المحاسب برو</h2><p>${escapeHtml(receipt.mode || titles[selectedMode])}</p><hr><p>رقم: ${escapeHtml(receipt.number || receipt.documentNumber || '')}</p><p>الصافي: ${escapeHtml(receipt.net || receipt.subtotal || '0.000000')} IQD</p><p>شكرًا لزيارتكم</p>`;
  }

  function populateCustomers() {
    if (!master?.customers) return;
    document.getElementById('customers').innerHTML = master.customers.map((customer) => `<option value="${escapeHtml(customer.code)}">${escapeHtml(customer.name)}</option>`).join('');
  }

  function renderStatus() {
    const shift = state?.shift;
    document.getElementById('shiftStatus').textContent = !shift ? 'لا يوجد شفت مفتوح' : shift.status === 'submitted_pending_sync' ? 'إغلاق الشفت بانتظار المزامنة والاعتماد' : `حالة الشفت: ${shift.status}`;
  }

  function updateNetwork() {
    const element = document.getElementById('networkStatus');
    element.textContent = navigator.onLine ? 'متصل' : 'أوف لاين';
    element.className = `badge ${navigator.onLine ? 'online' : 'offline'}`;
  }

  function normalize(value) {
    const text = String(value).trim();
    if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error('قيمة عشرية غير صالحة');
    return fromScaled(toScaled(text));
  }
  function toScaled(value) { const [whole, fraction = ''] = String(value).split('.'); return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')); }
  function fromScaled(value) { return `${value / 1000000n}.${String(value % 1000000n).padStart(6, '0')}`; }
  function multiply(left, right) { return fromScaled((toScaled(left) * toScaled(right) + 500000n) / 1000000n); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[character])); }
  function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

  window.PosUI = { openShift, allocateOffline, completeSale, returnLast, closeShift, printReceipt, remove, addProduct, changeQty };
  void initialize();
}());
