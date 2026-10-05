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
  let saleInProgress = false;
  let marketReceivedManual = false;
  let activeHeldMarketId = null;
  const standaloneCashier = document.body.dataset.standaloneCashier === "true";
  let localReceipt;
  const companyContext=(()=>{try{return JSON.parse(localStorage.getItem('almahasib_company_context')||'{}')}catch{return{}}})();
  const companyScope=String(companyContext.id||companyContext.code||'unscoped').replace(/[^A-Za-z0-9_-]/g,'_');
  const marketCatalogKey='tenant:'+companyScope+':market_catalog_v1';
  function marketCatalog(){try{return JSON.parse(localStorage.getItem(marketCatalogKey)||'[]')}catch{return[]}}

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
    // Restaurant mode has its own cashier runtime. Do not initialize the legacy
    // POS/offline device flow here; it causes warehouse/local-storage blockers.
    if (selectedMode === 'restaurant') return;
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
    document.getElementById('marketReceived')?.addEventListener('input', () => { marketReceivedManual = true; updateMarketChange(); });
    if(selectedMode==='market'){
      const admin=document.getElementById('marketCatalogButton'); if(admin) admin.style.display='';
      const tools=document.getElementById('marketSaleTools'); if(tools) tools.style.display='block';
      const list=document.getElementById('marketCatalog'); if(list) list.style.display='grid';
      renderMarketCatalog();renderMarketShift();if(standaloneCashier)showHeldMarketSales();
      window.addEventListener('storage',(e)=>{if(e.key===marketCatalogKey)renderMarketCatalog()});
      window.addEventListener('almahasib:market-update',renderMarketCatalog);
      // Market has a tenant-scoped IndexedDB/cloud runtime and must not be
      // blocked by the legacy UUID POS-device bootstrap.
      for(let attempt=0;attempt<30&&!window.AlMahasibMarketOffline;attempt+=1)await delay(100);
      if(window.AlMahasibMarketOffline){await window.AlMahasibMarketOffline.open();await window.AlMahasibMarketOffline.restore();await window.AlMahasibMarketOffline.renderStatus();renderMarketCatalog()}
      return;
    }
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
    let warehouse = master.warehouses[0];
    if (!warehouse && selectedMode === 'restaurant') {
      const created = await api('/api/v1/warehouses', {
        method: 'POST',
        body: JSON.stringify({ code: 'REST-MAIN', name: 'مخزن هوى دجلة الرئيسي', kind: 'pos' })
      });
      warehouse = created.warehouse;
      master = await api('/api/v1/master-data');
    }
    if (!warehouse && selectedMode === 'market') {
      const created = await api('/api/v1/warehouses', {
        method: 'POST',
        body: JSON.stringify({ code: 'MARKET-MAIN', name: 'المخزن الرئيسي للماركت والمجمع', kind: 'pos' })
      });
      warehouse = created.warehouse;
      master = await api('/api/v1/master-data');
    }
    if (!warehouse && selectedMode === 'enterprise') {
      const created = await api('/api/v1/warehouses', {
        method: 'POST',
        body: JSON.stringify({ code: 'ENTERPRISE-MAIN', name: 'المخزن الرئيسي للشركة', kind: 'pos' })
      });
      warehouse = created.warehouse;
      master = await api('/api/v1/master-data');
    }
    if (!warehouse) throw new Error('تعذر تجهيز مخزن نقطة البيع تلقائيًا');
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
  function changeQty(index,delta){if(saleInProgress)return;const x=cart[index];if(!x)return;const q=toScaled(x.quantity)+BigInt(delta)*1000000n;if(q<=0n)cart.splice(index,1);else{if(selectedMode==='market'){const stock=marketCatalog().find(z=>z.id===x.itemId);if(stock&&Number(fromScaled(q))>Number(stock.qty||0))return alert('الكمية المطلوبة أكبر من الرصيد')}x.quantity=fromScaled(q)}saveRestaurantCart();renderCart()}
  function saveRestaurantCart(){if(selectedMode==='restaurant')localStorage.setItem('almahasib_restaurant_open_order',JSON.stringify(cart))}
  function restoreRestaurantCart(){if(selectedMode!=='restaurant')return;try{const x=JSON.parse(localStorage.getItem('almahasib_restaurant_open_order')||'[]');if(Array.isArray(x))cart=x}catch{}renderCart()}
  function renderMarketCatalog(){
    if(selectedMode!=='market')return;
    const el=document.getElementById('marketCatalog'); if(!el||standaloneCashier)return;
    const items=marketCatalog().filter(x=>Number(x.qty)>0);
    el.innerHTML=items.slice(0,300).map((x,i)=>'<div class="product-card" onclick="PosUI.addMarketProduct(\''+x.id+'\')"><div class="product-photo">🛒</div><div class="product-info"><b>'+escapeHtml(x.name)+'</b><small>'+escapeHtml(x.category||'')+' | '+escapeHtml(x.barcode)+'</small><span class="product-price">'+Number(x.price||0).toLocaleString('ar-IQ')+' د.ع</span><small>الرصيد: '+x.qty+' '+escapeHtml(x.unit||'')+'</small></div></div>').join('')||'<div>لا توجد مواد في مستودع هذه الشركة. افتح إدارة الأصناف لإضافتها.</div>';
  }
  function addMarketProduct(id){
    if(saleInProgress)return false;
    const x=marketCatalog().find(z=>z.id===id); if(!x)return;
    if(Number(x.qty)<=0)return alert('الصنف نافد من المخزون');
    const line=cart.find(z=>z.itemId===x.id);
    if(line){if(Number(line.quantity)>=Number(x.qty))return alert('الكمية المطلوبة أكبر من الرصيد');line.quantity=fromScaled(toScaled(line.quantity)+1000000n)}
    else cart.push({itemId:x.id,unitId:'market-unit',name:x.name,quantity:'1.000000',unitPrice:normalize(String(x.price||0)),market:true,barcode:x.barcode});
    renderCart();
    const reading=document.getElementById('marketLastScan');
    if(reading){const current=cart.find(z=>z.itemId===x.id);reading.innerHTML='<b>'+escapeHtml(x.name)+'</b><br>العدد: '+Number(current.quantity)+' | السعر: '+Number(current.unitPrice).toLocaleString('ar-IQ')+' د.ع | المجموع: '+Number(multiply(current.quantity,current.unitPrice)).toLocaleString('ar-IQ')+' د.ع';}
    return true;
  }
  function setMarketQty(index,value){
    if(saleInProgress)return;
    try{const line=cart[index];if(!line)return;const q=normalize(value),stock=marketCatalog().find(x=>x.id===line.itemId);if(toScaled(q)<=0n)throw new Error('العدد يجب أن يكون أكبر من صفر');if(!stock||Number(q)>Number(stock.qty))throw new Error('الكمية المطلوبة أكبر من الرصيد');line.quantity=q;renderCart()}catch(e){alert(e.message);renderCart()}
  }
  function scanBarcode() {
    try {
      if(selectedMode==='market'){
        const input=document.getElementById('barcodeInput'),code=input.value.trim(),x=marketCatalog().find(z=>String(z.barcode)===code);
        if(!x)throw new Error('الباركود غير موجود في مستودع هذه الشركة');
        addMarketProduct(x.id);input.value='';input.focus();return;
      }
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
    else body.innerHTML = cart.map((line, index) => `<tr><td>${escapeHtml(line.name)}${standaloneCashier ? `<br><small dir="ltr">${escapeHtml(line.barcode||'')}</small>` : ''}</td><td><div class="qty"><button onclick="PosUI.changeQty(${index},-1)">−</button>${standaloneCashier ? `<input aria-label="عدد المادة" type="number" min="0.000001" step="0.000001" value="${Number(line.quantity)}" onchange="PosUI.setMarketQty(${index},this.value)">` : `<b>${line.quantity}</b>`}<button onclick="PosUI.changeQty(${index},1)">+</button></div></td><td>${standaloneCashier ? Number(line.unitPrice).toLocaleString("ar-IQ") : line.unitPrice}</td><td>${standaloneCashier ? Number(multiply(line.quantity,line.unitPrice)).toLocaleString("ar-IQ") : multiply(line.quantity, line.unitPrice)}</td><td><button class="btn btn-danger" onclick="PosUI.remove(${index})">×</button></td></tr>`).join('');
    const discount = normalize(document.getElementById('discountInput').value || '0');
    const gross = cart.reduce((sum, line) => sum + toScaled(multiply(line.quantity, line.unitPrice)), 0n);
    const net = gross - toScaled(discount);
    if(selectedMode==='market'){
      if(!cart.length)marketReceivedManual=false;
      const receivedInput=document.getElementById('marketReceived');
      if(receivedInput&&!marketReceivedManual)receivedInput.value=String(Number(fromScaled(net>0n?net:0n)));
    }
    document.getElementById('netTotal').textContent = (standaloneCashier ? Number(fromScaled(net > 0n ? net : 0n)).toLocaleString("ar-IQ") : fromScaled(net > 0n ? net : 0n)); if(selectedMode==='market')updateMarketChange();
    if(selectedMode==='market'&&activeHeldMarketId){const draft=loadHeldMarketSales().find(x=>x.id===activeHeldMarketId);if(draft){storeHeldMarketDraft(activeHeldMarketId,draft.ref);showHeldMarketSales()}}
  }

  function remove(index) { if(saleInProgress)return; cart.splice(index, 1); saveRestaurantCart(); renderCart(); if(selectedMode==='market')updateMarketChange(); }

  function marketHeldKey(){return 'tenant:'+companyScope+':market_held_sales_v1'}
  function marketInvoicesKey(){return 'tenant:'+companyScope+':market_invoices_v1'}
  function marketCashierId(){return (new URLSearchParams(location.search).get('cashierCode')||new URLSearchParams(location.search).get('cashier')||'main').replace(/[^A-Za-z0-9_\u0600-\u06FF-]/g,'_')}
  function marketCashierName(){return getMarketShift()?.cashier||localStorage.getItem('tenant:'+companyScope+':market_cashier_name_'+marketCashierId())||new URLSearchParams(location.search).get('cashier')||'الكاشير الرئيسي'}
  function updateMarketCashierLabel(){const label=document.getElementById('cashierName');if(label)label.textContent='الكاشير: '+marketCashierName()}
  function marketShiftKey(){return 'tenant:'+companyScope+':market_shift_'+marketCashierId()+'_v1'}
  function marketShiftHistoryKey(){return 'tenant:'+companyScope+':market_shift_history_'+marketCashierId()+'_v1'}
  function getMarketShift(){try{return JSON.parse(localStorage.getItem(marketShiftKey())||'null')}catch{return null}}
  function marketOpenShift(){
    if(getMarketShift()?.status==='open')return alert('الكاشير مفتوح بالفعل');
    const opening=Number(document.getElementById('marketOpeningBalance')?.value||prompt('الرصيد الافتتاحي:','0')||0);
    const cashier=prompt('اسم الموظف الكاشير:',marketCashierName());if(cashier===null||!cashier.trim())return;localStorage.setItem('tenant:'+companyScope+':market_cashier_name_'+marketCashierId(),cashier.trim());
    const s={id:crypto.randomUUID(),status:'open',cashier:cashier.trim(),opening,openedAt:new Date().toISOString(),expenses:[]};
    localStorage.setItem(marketShiftKey(),JSON.stringify(s));localStorage.setItem('tenant:'+companyScope+':market_opening_balance',String(opening));window.AlMahasibMarketOffline?.queueTransaction('shift_open',{id:s.id,shiftId:s.id,cashier:s.cashier,cashierCode:marketCashierId(),opening:s.opening,occurredAt:s.openedAt});renderMarketShift();alert('تم فتح شفت الكاشير');
  }
  function marketExpense(){
    const s=getMarketShift();if(!s||s.status!=='open')return alert('افتح الشفت أولًا');
    const title=prompt('بيان المصروف:');if(!title)return;const amount=Number(prompt('المبلغ:','0')||0);if(!(amount>0))return;
    const expense={id:crypto.randomUUID(),title,amount,at:new Date().toISOString()};s.expenses.push(expense);localStorage.setItem(marketShiftKey(),JSON.stringify(s));window.AlMahasibMarketOffline?.queueTransaction('expense',{id:expense.id,shiftId:s.id,cashier:s.cashier,cashierCode:marketCashierId(),title,amount,occurredAt:expense.at});renderMarketShift();
  }
  function marketShiftSummary(s=getMarketShift()){
    if(!s)return null;const invoices=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]').filter(x=>new Date(x.at)>=new Date(s.openedAt)&&(!s.closedAt||new Date(x.at)<=new Date(s.closedAt)));
    const returns=JSON.parse(localStorage.getItem(marketReturnsKey())||'[]').filter(x=>new Date(x.at)>=new Date(s.openedAt)&&(!s.closedAt||new Date(x.at)<=new Date(s.closedAt)));
    const valid=invoices.filter(x=>!x.cancelled),sales=invoices.reduce((n,x)=>n+Number(x.net||0),0),returnAmount=returns.reduce((n,x)=>n+Number(x.amount||0),0),cancelled=invoices.filter(x=>x.cancelled).reduce((n,x)=>n+Number(x.net||0),0),expenses=(s.expenses||[]).reduce((n,x)=>n+Number(x.amount||0),0);
    return {invoices,valid,returned:returns,sales,returns:returnAmount,cancelled,expenses,expected:Number(s.opening||0)+sales-returnAmount-cancelled-expenses};
  }
  function printMarketStatement(){
    const s=getMarketShift();if(!s)return alert('لا يوجد شفت حالي');const m=marketShiftSummary(s),company=companyContext.name||'الشركة';
    const w=open('','_blank');w.document.write('<html dir="rtl"><head><title>كشف الكاشير</title><style>body{font-family:Arial;padding:28px;color:#000}h1{text-align:center}table{width:100%;border-collapse:collapse}td,th{border:1px solid #777;padding:7px}.sum{font-size:18px;line-height:2}</style></head><body><h1>'+escapeHtml(company)+'</h1><h2>كشف الكاشير / الشفت</h2><p>الكاشير: '+escapeHtml(s.cashier)+'</p><p>فتح: '+new Date(s.openedAt).toLocaleString('ar-IQ')+(s.closedAt?' — إغلاق: '+new Date(s.closedAt).toLocaleString('ar-IQ'):'')+'</p><div class="sum">الرصيد الافتتاحي: '+s.opening.toLocaleString('ar-IQ')+' د.ع<br>المبيعات: '+m.sales.toLocaleString('ar-IQ')+' د.ع<br>المرتجعات: '+m.returns.toLocaleString('ar-IQ')+' د.ع<br>الإلغاءات: '+m.cancelled.toLocaleString('ar-IQ')+' د.ع<br>المصروفات: '+m.expenses.toLocaleString('ar-IQ')+' د.ع<br><b>النقد المتوقع: '+m.expected.toLocaleString('ar-IQ')+' د.ع</b>'+(s.counted!=null?'<br>النقد الفعلي: '+Number(s.counted).toLocaleString('ar-IQ')+' د.ع<br>فرق الصندوق: '+Number(s.difference).toLocaleString('ar-IQ')+' د.ع':'')+'</div><h3>الفواتير</h3><table><tr><th>الرقم</th><th>الوقت</th><th>الصافي</th><th>الحالة</th></tr>'+m.invoices.map(x=>'<tr><td>'+escapeHtml(x.number)+'</td><td>'+new Date(x.at).toLocaleString('ar-IQ')+'</td><td>'+Number(x.net||0).toLocaleString('ar-IQ')+'</td><td>'+(x.returned?'مرتجع':'بيع')+'</td></tr>').join('')+'</table><h3>المصروفات</h3><table><tr><th>البيان</th><th>المبلغ</th><th>الوقت</th></tr>'+(s.expenses||[]).map(x=>'<tr><td>'+escapeHtml(x.title)+'</td><td>'+Number(x.amount).toLocaleString('ar-IQ')+'</td><td>'+new Date(x.at).toLocaleString('ar-IQ')+'</td></tr>').join('')+'</table><br><p>توقيع الكاشير: ____________ &nbsp;&nbsp; توقيع المستلم: ____________</p></body></html>');w.document.close();w.print();
  }
  async function closeMarketShift(handover=false){
    const s=getMarketShift();if(!s||s.status!=='open')return alert('لا يوجد شفت مفتوح');const m=marketShiftSummary(s),answer=prompt('النقد الفعلي في الصندوق:',String(m.expected));if(answer===null)return;const counted=Number(answer);if(!Number.isFinite(counted)||counted<0)return alert('أدخل مبلغًا صحيحًا');
    if(navigator.onLine){try{await disconnectPhoneScanner(s.id)}catch(e){return alert('تعذر إيقاف الماسح. أعد المحاولة قبل إغلاق الشفت.')}}
    s.status='closed';s.closedAt=new Date().toISOString();s.counted=counted;s.difference=counted-m.expected;s.closeType=handover?'handover':'close';
    const h=JSON.parse(localStorage.getItem(marketShiftHistoryKey())||'[]');h.unshift({...s,summary:m});localStorage.setItem(marketShiftHistoryKey(),JSON.stringify(h.slice(0,200)));localStorage.setItem(marketShiftKey(),JSON.stringify(s));window.AlMahasibMarketOffline?.queueTransaction('shift_close',{id:crypto.randomUUID(),shiftId:s.id,cashier:s.cashier,cashierCode:marketCashierId(),opening:s.opening,counted:s.counted,difference:s.difference,closeType:s.closeType,summary:m,occurredAt:s.closedAt});renderMarketShift();
    alert((handover?'تم تسليم الشفت':'تم إغلاق وتسوية الشفت')+'\nفرق الصندوق: '+s.difference.toLocaleString('ar-IQ')+' د.ع');
  }
  function renderMarketShift(){if(selectedMode!=='market')return;updateMarketCashierLabel();const s=getMarketShift(),el=document.getElementById('marketShiftInfo');if(!el)return;el.textContent=!s?'لا يوجد شفت مفتوح':s.status==='open'?'الشفت مفتوح منذ '+new Date(s.openedAt).toLocaleTimeString('ar-IQ'):'آخر شفت مغلق — فرق الصندوق '+Number(s.difference||0).toLocaleString('ar-IQ')+' د.ع';}
  function loadHeldMarketSales(){try{return JSON.parse(localStorage.getItem(marketHeldKey())||'[]')}catch{return[]}}
  function storeHeldMarketDraft(id,ref){
    const a=loadHeldMarketSales(),old=a.find(x=>x.id===id);
    const draft={id,ref,at:old?.at||new Date().toISOString(),updatedAt:new Date().toISOString(),cart:structuredClone(cart),discount:document.getElementById('discountInput').value||'0',received:document.getElementById('marketReceived')?.value||'0',receivedManual:marketReceivedManual};
    const index=a.findIndex(x=>x.id===id);if(index<0)a.unshift(draft);else a[index]=draft;
    localStorage.setItem(marketHeldKey(),JSON.stringify(a));
  }
  function holdMarketSale(){
    if(saleInProgress)return;
    if(!cart.length)return alert('لا توجد مواد لتعليقها');
    const a=loadHeldMarketSales(),old=a.find(x=>x.id===activeHeldMarketId);
    let next=1;while(a.some(x=>x.ref==='انتظار '+next))next+=1;
    const ref=old?.ref||('انتظار '+next);
    storeHeldMarketDraft(activeHeldMarketId||crypto.randomUUID(),ref.trim()||old?.ref||('انتظار '+(a.length+1)));
    activeHeldMarketId=null;cart=[];marketReceivedManual=false;document.getElementById('discountInput').value='0';renderCart();showHeldMarketSales();
  }
  function showHeldMarketSales(){
    const el=document.getElementById('marketHeldList');if(!el)return;
    const a=loadHeldMarketSales();el.style.display='block';
    el.innerHTML='<h3>فواتير الانتظار</h3><div class="held-market-grid">'+(a.length?a.map(x=>{
      const lines=x.cart||[],total=lines.reduce((sum,l)=>sum+toScaled(multiply(l.quantity,l.unitPrice)),0n)-toScaled(x.discount||'0');
      return '<article class="held-market-card'+(x.id===activeHeldMarketId?' editing':'')+'"><b>'+escapeHtml(x.ref)+'</b><small>'+escapeHtml(new Date(x.updatedAt||x.at).toLocaleString('ar-IQ'))+'</small><p>'+lines.length+' أصناف — '+Number(fromScaled(total>0n?total:0n)).toLocaleString('ar-IQ')+' د.ع</p><div class="actions"><button class="btn btn-primary" data-held-open="'+escapeHtml(x.id)+'">'+(x.id===activeHeldMarketId?'قيد الإضافة':'فتح وإضافة مواد')+'</button><button class="btn btn-danger" data-held-delete="'+escapeHtml(x.id)+'">حذف</button></div></article>';
    }).join(''):'<p class="muted">لا توجد فواتير بالانتظار</p>')+'</div>';
    el.onclick=(event)=>{const open=event.target.closest('[data-held-open]'),remove=event.target.closest('[data-held-delete]');if(open)restoreHeldMarketSale(open.dataset.heldOpen);if(remove)deleteHeldMarketSale(remove.dataset.heldDelete)};
    const label=document.getElementById('activeInvoiceLabel');if(label)label.textContent=activeHeldMarketId?'إضافة إلى: '+(a.find(x=>x.id===activeHeldMarketId)?.ref||'فاتورة انتظار'):'فاتورة جديدة';
  }
  function restoreHeldMarketSale(id){
    if(saleInProgress||id===activeHeldMarketId)return;
    const a=loadHeldMarketSales(),x=a.find(z=>z.id===id);if(!x)return;
    const catalog=marketCatalog(),bad=(x.cart||[]).find(l=>{const stock=catalog.find(z=>z.id===l.itemId);return !stock||Number(stock.qty||0)<Number(l.quantity||0)});
    if(bad)return alert('لا يمكن الفتح: رصيد الصنف غير كافٍ أو تم حذفه: '+bad.name);
    if(cart.length&&!activeHeldMarketId){if(!confirm('حفظ الفاتورة الحالية بالانتظار وفتح الفاتورة المختارة؟'))return;storeHeldMarketDraft(crypto.randomUUID(),'انتظار '+(a.length+1))}
    if(activeHeldMarketId){const old=a.find(z=>z.id===activeHeldMarketId);if(old)storeHeldMarketDraft(activeHeldMarketId,old.ref)}
    activeHeldMarketId=id;cart=structuredClone(x.cart||[]);document.getElementById('discountInput').value=x.discount||'0';
    marketReceivedManual=!!x.receivedManual;const received=document.getElementById('marketReceived');if(received)received.value=x.received||'0';
    renderCart();showHeldMarketSales();document.getElementById('barcodeInput').focus();
  }
  function deleteHeldMarketSale(id){
    if(saleInProgress||!confirm('حذف فاتورة الانتظار؟'))return;
    const a=loadHeldMarketSales().filter(z=>z.id!==id);localStorage.setItem(marketHeldKey(),JSON.stringify(a));
    if(activeHeldMarketId===id){activeHeldMarketId=null;cart=[];document.getElementById('discountInput').value='0';renderCart()}showHeldMarketSales();
  }
  function updateMarketChange(){
    if(selectedMode!=='market')return;
    const gross=cart.reduce((s,l)=>s+toScaled(multiply(l.quantity,l.unitPrice)),0n);
    const discount=normalize(document.getElementById('discountInput')?.value||'0');
    const net=gross-toScaled(discount),received=normalize(document.getElementById('marketReceived')?.value||'0');
    const ch=toScaled(received)-net;const el=document.getElementById('marketChange');if(el)el.textContent=standaloneCashier ? Number(fromScaled(ch>0n?ch:0n)).toLocaleString("ar-IQ") : fromScaled(ch>0n?ch:0n);
  }
  function marketReturnsKey(){return 'tenant:'+companyScope+':market_returns_v1'}
  async function returnMarketInvoice(){
    const number=prompt('أدخل رقم الفاتورة المراد إرجاعها:');if(!number)return;
    const a=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]'),x=a.find(z=>z.number===number);
    if(!x)return alert('الفاتورة غير موجودة على هذا الجهاز');
    if(x.returned)return alert('هذه الفاتورة مرتجعة بالكامل مسبقًا');if(x.cancelled)return alert('لا يمكن إرجاع فاتورة ملغاة');
    const reason=prompt('سبب المرتجع:');if(!reason)return alert('سبب المرتجع مطلوب');
    const choice=prompt('اكتب "كامل" لإرجاع الفاتورة كلها، أو أدخل رقم تسلسل المادة (1،2،3...) لإرجاع مادة محددة:','كامل');if(!choice)return;
    let selected=[];
    if(choice.trim()==='كامل'){selected=(x.lines||[]).map((l,i)=>{const already=(x.partialReturns||[]).flatMap(r=>r.lines||[]).filter(z=>z.itemId===l.itemId).reduce((n,z)=>n+Number(z.quantity||0),0),remaining=Math.max(0,Number(l.quantity||0)-already);return remaining>0?{line:{...l,quantity:String(remaining)},index:i}:null}).filter(Boolean);if(!selected.length)return alert('تم إرجاع كامل الفاتورة مسبقًا')}
    else {const i=Number(choice)-1;if(!Number.isInteger(i)||!x.lines?.[i])return alert('رقم المادة غير صحيح');const line=x.lines[i];const already=(x.partialReturns||[]).flatMap(r=>r.lines||[]).filter(l=>l.itemId===line.itemId).reduce((n,l)=>n+Number(l.quantity||0),0),max=Math.max(0,Number(line.quantity||0)-already);if(max<=0)return alert('تم إرجاع كامل كمية هذه المادة مسبقًا');const q=Number(prompt('الكمية المرتجعة من '+line.name+' (المتبقي '+max+'):',String(max))||0);if(!(q>0&&q<=max))return alert('كمية المرتجع غير صحيحة');selected=[{line:{...line,quantity:String(q)},index:i}]}
    if(!confirm('تأكيد المرتجع وإعادة الكمية للمخزون؟'))return;
    let cat=marketCatalog(),amount=0;selected.forEach(({line})=>{amount+=Number(line.quantity||0)*Number(line.unitPrice||0)});
    const returnRow={id:crypto.randomUUID(),invoice:number,reason,lines:selected.map(z=>z.line),amount,at:new Date().toISOString(),cashier:new URLSearchParams(location.search).get('cashier')||'الكاشير الرئيسي',cashierCode:marketCashierId(),shiftId:getMarketShift()?.id||null};
    if(navigator.onLine){const rr=await fetch('/api/v1/market/stock-reversal',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...returnRow,kind:'return'})});const body=await rr.json().catch(()=>({}));if(!rr.ok)return alert(body?.error?.message||'تعذر اعتماد المرتجع مركزيًا');cat=body.snapshot.catalog;localStorage.setItem(marketCatalogKey,JSON.stringify(cat));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',body.snapshot.updatedAt);await window.AlMahasibMarketOffline?.saveLocalSnapshot(cat,body.snapshot.updatedAt)}else{selected.forEach(({line})=>{const item=cat.find(z=>z.id===line.itemId);if(item)item.qty=Number(item.qty||0)+Number(line.quantity||0)});localStorage.setItem(marketCatalogKey,JSON.stringify(cat));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',returnRow.at);await window.AlMahasibMarketOffline?.queueTransaction('return',{...returnRow,occurredAt:returnRow.at});await window.AlMahasibMarketOffline?.saveSnapshot('market-return')}
    const returns=JSON.parse(localStorage.getItem(marketReturnsKey())||'[]');returns.unshift(returnRow);localStorage.setItem(marketReturnsKey(),JSON.stringify(returns.slice(0,1000)));
    if(choice.trim()==='كامل'){x.returned=true;x.returnedAt=new Date().toISOString();x.returnReason=reason}else{x.partialReturns=x.partialReturns||[];x.partialReturns.push({reason,lines:selected.map(z=>z.line),at:new Date().toISOString()})}
    localStorage.setItem(marketInvoicesKey(),JSON.stringify(a));renderMarketCatalog();alert('تم تسجيل المرتجع وإعادة الكمية للمخزون');
  }
  async function cancelMarketInvoice(){
    const number=prompt('رقم الفاتورة المراد إلغاؤها:');if(!number)return;const a=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]'),x=a.find(z=>z.number===number);if(!x)return alert('الفاتورة غير موجودة');if(x.returned||x.cancelled)return alert('الفاتورة مرتجعة أو ملغاة مسبقًا');if((x.partialReturns||[]).length)return alert('لا يمكن إلغاء فاتورة عليها مرتجع جزئي؛ أكمل المرتجع أو راجع السجل');
    const reason=prompt('سبب الإلغاء:');if(!reason)return alert('سبب الإلغاء مطلوب');if(!confirm('تأكيد إلغاء الفاتورة وإعادة جميع الكميات؟'))return;
    let cat=marketCatalog();const cancelledAt=new Date().toISOString(),cancelRow={id:crypto.randomUUID(),invoice:x.number,amount:Number(x.net||0),reason,lines:x.lines||[],shiftId:getMarketShift()?.id||null,cashier:new URLSearchParams(location.search).get('cashier')||'الكاشير الرئيسي',cashierCode:marketCashierId(),occurredAt:cancelledAt};
    if(navigator.onLine){const rr=await fetch('/api/v1/market/stock-reversal',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...cancelRow,kind:'cancel'})});const body=await rr.json().catch(()=>({}));if(!rr.ok)return alert(body?.error?.message||'تعذر اعتماد الإلغاء مركزيًا');cat=body.snapshot.catalog;localStorage.setItem(marketCatalogKey,JSON.stringify(cat));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',body.snapshot.updatedAt);await window.AlMahasibMarketOffline?.saveLocalSnapshot(cat,body.snapshot.updatedAt)}else{(x.lines||[]).forEach(l=>{const item=cat.find(z=>z.id===l.itemId);if(item)item.qty=Number(item.qty||0)+Number(l.quantity||0)});localStorage.setItem(marketCatalogKey,JSON.stringify(cat));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',cancelledAt);await window.AlMahasibMarketOffline?.queueTransaction('cancel',cancelRow);await window.AlMahasibMarketOffline?.saveSnapshot('market-cancel')}
    x.cancelled=true;x.cancelledAt=cancelledAt;x.cancelReason=reason;localStorage.setItem(marketInvoicesKey(),JSON.stringify(a));renderMarketCatalog();alert('تم إلغاء الفاتورة وحفظ السبب وإعادة المخزون');
  }

  async function completeSale(printAfter = false) {
    if(saleInProgress)return;
    saleInProgress=true;
    const checkoutButton=document.getElementById('checkoutButton');if(checkoutButton)checkoutButton.disabled=true;
    try {
      if (!cart.length) throw new Error('أضف مادة واحدة على الأقل');
      const gross = cart.reduce((sum, line) => sum + toScaled(multiply(line.quantity, line.unitPrice)), 0n);
      const discount = normalize(document.getElementById('discountInput').value || '0');
      const net = fromScaled(gross - toScaled(discount));
      if (toScaled(net) < 0n) throw new Error('الخصم يتجاوز الإجمالي');

      // Market catalog uses its own tenant-scoped IDs. Do not send those IDs
      // through the legacy UUID POS engine; commit locally first and sync the
      // company catalog snapshot through the market cloud channel.
      if(selectedMode==='market'){
        const shift=getMarketShift();if(!shift||shift.status!=='open')throw new Error('افتح شفت الكاشير أولًا');
        const received=normalize(document.getElementById('marketReceived')?.value||net);
        if(toScaled(received)<toScaled(net))throw new Error('المبلغ المستلم أقل من صافي الفاتورة');
        let catalog=marketCatalog();
        for(const l of cart){const x=catalog.find(z=>z.id===l.itemId);if(!x)throw new Error('أحد الأصناف غير موجود');if(Number(x.qty||0)<Number(l.quantity||0))throw new Error('الرصيد غير كافٍ للصنف: '+l.name)}
        const number='MKT-'+Date.now()+'-'+crypto.randomUUID().slice(0,6),saleId=crypto.randomUUID(),saleAt=new Date().toISOString();
        const salePayload={id:saleId,invoice:number,shiftId:shift.id,cashier:shift.cashier,cashierCode:marketCashierId(),gross:fromScaled(gross),discount,net,received,change:fromScaled(toScaled(received)-toScaled(net)),lines:structuredClone(cart),occurredAt:saleAt};
        if(navigator.onLine){
          const response=await fetch('/api/v1/market/sale',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(salePayload)});
          const body=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(body?.error?.message||body?.message||'تعذر اعتماد البيع من المخزون المركزي');
          catalog=body.snapshot.catalog;localStorage.setItem(marketCatalogKey,JSON.stringify(catalog));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',body.snapshot.updatedAt);
          await window.AlMahasibMarketOffline?.saveLocalSnapshot(catalog,body.snapshot.updatedAt);
        }else{
          cart.forEach(l=>{const x=catalog.find(z=>z.id===l.itemId);x.qty=Number(x.qty||0)-Number(l.quantity||0)});
          localStorage.setItem(marketCatalogKey,JSON.stringify(catalog));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',saleAt);
          await window.AlMahasibMarketOffline?.queueTransaction('sale',salePayload);await window.AlMahasibMarketOffline?.saveSnapshot('market-sale');
        }
        localReceipt={number,lines:structuredClone(cart),gross:fromScaled(gross),discount,net,cash:net,due:'0.000000',received,change:salePayload.change,mode:titles[selectedMode],at:saleAt,returned:false,cancelled:false,cashier:shift.cashier,cashierCode:marketCashierId()};
        const invoices=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]');invoices.unshift(localReceipt);localStorage.setItem(marketInvoicesKey(),JSON.stringify(invoices.slice(0,1000)));
        if(activeHeldMarketId){localStorage.setItem(marketHeldKey(),JSON.stringify(loadHeldMarketSales().filter(x=>x.id!==activeHeldMarketId)));activeHeldMarketId=null;}
        renderMarketCatalog();renderReceipt(localReceipt);cart=[];renderCart();if(standaloneCashier)showHeldMarketSales();const r=document.getElementById('marketReceived');if(r)r.value='0';updateMarketChange();
        alert('✅ تم حفظ البيع وخصم المخزون'+(navigator.onLine?' وإرساله للمزامنة.':' أوف لاين وسيزامن عند عودة الاتصال.'));if(printAfter)printReceipt();document.getElementById('barcodeInput').focus();return;
      }

      state = await offline.getPosState();
      if (!state?.shift || state.shift.status !== 'open') throw new Error('افتح الشفت أولًا');
      const paymentMode = document.getElementById('paymentMode').value;
      const cash = paymentMode === 'cash' ? net : paymentMode === 'mixed' ? normalize(document.getElementById('cashAmount').value || '0') : '0.000000';
      if (toScaled(cash) > toScaled(net)) throw new Error('النقد يتجاوز صافي الفاتورة');
      const customerText = document.getElementById('customerInput').value.trim();
      const customer = master?.customers?.find((entry) => entry.code === customerText || entry.name === customerText);
      if (toScaled(cash) < toScaled(net) && !customer) throw new Error('اختر عميلًا للبيع الآجل أو المختلط');
      const orderContext = { mode: selectedMode, reference: document.getElementById('contextValue').value.trim() };
      const payload = {documentNumber:'POS-'+Date.now()+'-'+crypto.randomUUID().slice(0,6),currency:'IQD',partyId:customer?.id||null,originalDocumentId:null,lines:cart.map(({name,...line})=>({...line,originalLineId:null})),payments:toScaled(cash)>0n?[{method:'cash',amount:cash,reference:null}]:[],discountAmount:discount,orderContext};
      await offline.enqueuePosDocument('pos.sale', payload);
      localReceipt={number:payload.documentNumber,lines:structuredClone(cart),gross:fromScaled(gross),discount,net,cash,due:fromScaled(toScaled(net)-toScaled(cash)),mode:titles[selectedMode]};
      renderReceipt(localReceipt);cart=[];saveRestaurantCart();renderCart();
      alert(navigator.onLine?'✅ حُفظ البيع وأُرسل للمزامنة.':'✅ حُفظ البيع أوف لاين ضمن مخصص الجهاز.');
    } catch (error) { alert(error.message); } finally { saleInProgress=false;if(checkoutButton)checkoutButton.disabled=false; }
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
    const company=companyContext.name||'المحاسب برو';
    const cashier=receipt.cashier||marketCashierName();
    const lines=receipt.lines||[];
    const net=receipt.net||receipt.subtotal||'0.000000', cash=receipt.cash||'0.000000', due=receipt.due||'0.000000', received=receipt.received||cash, change=receipt.change||'0.000000';
    document.getElementById('receipt').innerHTML =
      '<div style="font-family:Arial;text-align:center;color:#000"><h2 style="margin:0">'+escapeHtml(company)+'</h2>'+
      '<div>'+escapeHtml(receipt.mode||titles[selectedMode])+'</div><div>الكاشير: '+escapeHtml(cashier)+'</div>'+
      '<div>'+new Date(receipt.at||Date.now()).toLocaleString('ar-IQ')+'</div><hr>'+
      '<div style="text-align:right">رقم الفاتورة: <b>'+escapeHtml(receipt.number||receipt.documentNumber||'')+'</b></div>'+
      '<table style="width:100%;border-collapse:collapse;margin-top:8px"><thead><tr><th>المادة</th><th>الكمية</th><th>السعر</th><th>المجموع</th></tr></thead><tbody>'+
      lines.map(l=>'<tr><td>'+escapeHtml(l.name||'مادة')+'</td><td>'+escapeHtml(l.quantity||'1')+'</td><td>'+escapeHtml(l.unitPrice||'0')+'</td><td>'+escapeHtml(multiply(l.quantity||'1',l.unitPrice||'0'))+'</td></tr>').join('')+
      '</tbody></table><hr><div style="text-align:right"><div>الإجمالي: '+escapeHtml(receipt.gross||net)+' د.ع</div>'+
      '<div>الخصم: '+escapeHtml(receipt.discount||'0')+' د.ع</div><div><b>الصافي: '+escapeHtml(net)+' د.ع</b></div>'+
      '<div>المدفوع: '+escapeHtml(cash)+' د.ع</div>'+(selectedMode==='market'?'<div>المستلم: '+escapeHtml(received)+' د.ع</div><div>الباقي للزبون: '+escapeHtml(change)+' د.ع</div>':'')+'<div>المتبقي/الآجل: '+escapeHtml(due)+' د.ع</div></div>'+
      '<hr><p>شكرًا لزيارتكم</p></div>';
  }

  function reprintMarketInvoice(){
    if(selectedMode!=='market')return;
    const number=prompt('أدخل رقم الفاتورة لإعادة طباعتها:'); if(!number)return;
    const a=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]'),x=a.find(z=>z.number===number);
    if(!x)return alert('الفاتورة غير موجودة على هذا الجهاز');
    localReceipt=x;renderReceipt(x);printReceipt();
  }

  let marketScannerToken=null,marketScannerTimer=null,scannerPolling=false;
  async function pairPhoneScanner(){
    try{
      const shift=getMarketShift();if(!shift||shift.status!=='open')throw new Error('افتح شفت الكاشير أولًا');
      if(!window.AlMahasibMarketOffline)throw new Error('انتظر تحميل نظام المزامنة ثم أعد المحاولة');
      await window.AlMahasibMarketOffline.ensureShiftOpen(shift,marketCashierId());
      await window.AlMahasibMarketOffline.syncTransactions();
      const terminal=marketCashierId(),r=await fetch('/api/v1/market/scanner/pair',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({terminal,shiftId:shift.id,cashier:shift.cashier})}),b=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(b?.error?.message||'تعذر إنشاء ربط الهاتف');
      marketScannerToken=b.token;const el=document.getElementById('marketScannerStatus');if(el)el.textContent='رمز الهاتف: '+marketScannerToken.slice(0,8);
      const url=location.origin+'/market-scanner.html#'+encodeURIComponent(marketScannerToken);
      document.getElementById('scannerPairDialog')?.remove();
      const dialog=document.createElement('dialog');dialog.id='scannerPairDialog';
      dialog.style.cssText='max-width:420px;width:95%;border:0;border-radius:18px;padding:24px;text-align:center;background:white;color:#152238';
      const heading=document.createElement('h2');heading.textContent='ربط الماسح بالكاشير';dialog.append(heading);
      const hint=document.createElement('p');hint.textContent='افتح الماسح واضغط مسح رمز الربط ثم وجّه الكاميرا إلى هذا الرمز. صالح طوال الشفت حتى إغلاقه أو إيقاف الماسح.';dialog.append(hint);
      const qr=qrcode(0,'M');qr.addData(url);qr.make();
      const image=document.createElement('img');image.src=qr.createDataURL(6,24);image.alt='رمز QR لربط الماسح';image.style.cssText='width:280px;max-width:100%;image-rendering:pixelated';dialog.append(image);
      const token=document.createElement('input');token.value=marketScannerToken;token.readOnly=true;token.dir='ltr';token.style.cssText='width:100%;padding:10px;margin:14px 0';dialog.append(token);
      const close=document.createElement('button');close.textContent='إغلاق';close.className='btn';close.onclick=()=>{dialog.close();dialog.remove()};dialog.append(close);
      document.body.append(dialog);dialog.showModal();
      clearInterval(marketScannerTimer);marketScannerTimer=setInterval(pollPhoneScanner,350);
    }catch(e){alert(e.message)}
  }
  async function disconnectPhoneScanner(shiftId=getMarketShift()?.id){
    if(!shiftId)return;
    const response=await fetch('/api/v1/market/scanner/disconnect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({shiftId})});
    if(!response.ok)throw new Error('تعذر إيقاف الماسح');
    clearInterval(marketScannerTimer);marketScannerToken=null;document.getElementById('scannerPairDialog')?.remove();
    const status=document.getElementById('marketScannerStatus');if(status)status.textContent='الماسح متوقف';
  }
  async function stopPhoneScanner(){try{await disconnectPhoneScanner()}catch(e){alert(e.message)}}
  async function pollPhoneScanner(){
    if(!marketScannerToken||!navigator.onLine||saleInProgress||scannerPolling)return;
    scannerPolling=true;
    try{const r=await fetch('/api/v1/market/scanner/'+encodeURIComponent(marketScannerToken)+'/poll',{credentials:'same-origin'});if(r.status===410){clearInterval(marketScannerTimer);marketScannerToken=null;const el=document.getElementById('marketScannerStatus');if(el)el.textContent='انتهى ربط الهاتف';document.getElementById('scannerPairDialog')?.remove();return}if(!r.ok)return;const b=await r.json();for(const row of b.codes||[]){const item=marketCatalog().find(x=>String(x.barcode)===String(row.barcode));if(item){addMarketProduct(item.id);const el=document.getElementById('marketScannerStatus');if(el)el.textContent='✓ '+item.name}else{const el=document.getElementById('marketScannerStatus');if(el)el.textContent='غير معروف: '+row.barcode}}}catch{}finally{scannerPolling=false}
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

  window.PosUI = { stopPhoneScanner, scanBarcode, setMarketQty, pairPhoneScanner, cancelMarketInvoice, marketOpenShift, marketExpense, printMarketStatement, closeMarketShift, renderMarketShift, openShift, allocateOffline, completeSale, returnLast, closeShift, printReceipt, reprintMarketInvoice, remove, addProduct, addMarketProduct, changeQty, renderMarketCatalog, holdMarketSale, showHeldMarketSales, restoreHeldMarketSale, deleteHeldMarketSale, updateMarketChange, returnMarketInvoice };
  void initialize();
}());

