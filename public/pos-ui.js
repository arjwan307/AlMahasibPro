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
    document.getElementById('marketReceived')?.addEventListener('input', () => { marketReceivedManual = true; updateMarketChange(); saveMarketWork(); });
    if(selectedMode==='market'){
      const admin=document.getElementById('marketCatalogButton'); if(admin) admin.style.display='';
      const tools=document.getElementById('marketSaleTools'); if(tools) tools.style.display='block';
      const list=document.getElementById('marketCatalog'); if(list) list.style.display='grid';
      if(standaloneCashier){restoreMarketWork();window.addEventListener('pagehide',saveMarketWork);window.addEventListener('almahasib:cashier-records',()=>{renderMarketShift();showHeldMarketSales()})}renderMarketCatalog();renderMarketShift();if(standaloneCashier)showHeldMarketSales();
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
      if(receivedInput&&!marketReceivedManual&&(!document.getElementById('marketPaymentType')||document.getElementById('marketPaymentType').value==='cash'))receivedInput.value=String(Number(fromScaled(net>0n?net:0n)));
    }
    document.getElementById('netTotal').textContent = (standaloneCashier ? Number(fromScaled(net > 0n ? net : 0n)).toLocaleString("ar-IQ") : fromScaled(net > 0n ? net : 0n)); if(selectedMode==='market')updateMarketChange();
    saveMarketWork();
    if(selectedMode==='market'&&activeHeldMarketId){const draft=loadHeldMarketSales().find(x=>x.id===activeHeldMarketId);if(draft){storeHeldMarketDraft(activeHeldMarketId,draft.ref);showHeldMarketSales()}}
  }

  function remove(index) { if(saleInProgress)return; cart.splice(index, 1); saveRestaurantCart(); renderCart(); if(selectedMode==='market')updateMarketChange(); }

  function showMarketTrialCatalog(){document.getElementById('trialCatalogDialog')?.remove();const dialog=document.createElement('dialog');dialog.id='trialCatalogDialog';dialog.style.cssText='max-width:850px;width:96%;border:0;border-radius:18px;padding:24px;background:#112238;color:white';dialog.innerHTML='<h2>مواد التجربة</h2><input id="trialSearch" placeholder="ابحث باسم المادة أو الباركود" style="width:100%"><div id="trialQr" style="text-align:center;background:white;color:black"></div><div id="trialRows" style="max-height:55vh;overflow:auto;margin:16px 0"></div><button class="btn" id="trialClose">رجوع</button>';document.body.append(dialog);function render(){const q=dialog.querySelector('#trialSearch').value.trim();const rows=marketCatalog().filter(x=>x.demo===true&&(!q||x.name.includes(q)||String(x.barcode).includes(q)));dialog.querySelector('#trialRows').innerHTML='<table><tr><th>المادة</th><th>الباركود</th><th>السعر</th><th>الرصيد</th><th></th></tr>'+rows.map(x=>'<tr><td>'+escapeHtml(x.name)+'</td><td dir="ltr">'+escapeHtml(x.barcode)+'</td><td>'+Number(x.price).toLocaleString('ar-IQ')+'</td><td>'+Number(x.qty).toLocaleString('ar-IQ')+(Number(x.qty)<=0?' — نفد':Number(x.qty)<=Number(x.minQty)?' — منخفض':'')+'</td><td><button class="btn" data-trial-qr="'+escapeHtml(x.id)+'">رمز المسح</button> <button class="btn btn-primary" data-trial-add="'+escapeHtml(x.id)+'" '+(Number(x.qty)<=0?'disabled':'')+'>إضافة للفاتورة</button></td></tr>').join('')+'</table>'}dialog.querySelector('#trialSearch').oninput=render;dialog.querySelector('#trialClose').onclick=()=>dialog.remove();dialog.querySelector('#trialRows').onclick=event=>{const qr=event.target.closest('[data-trial-qr]'),add=event.target.closest('[data-trial-add]');if(add){addMarketProduct(add.dataset.trialAdd);dialog.remove()}if(qr){const x=marketCatalog().find(x=>x.id===qr.dataset.trialQr);const code=qrcode(0,'M');code.addData(String(x.barcode));code.make();dialog.querySelector('#trialQr').innerHTML='<h3>'+escapeHtml(x.name)+'</h3>'+code.createImgTag(6,8)+'<p dir="ltr">'+escapeHtml(x.barcode)+'</p>'}};render();dialog.showModal()}
  async function addMarketTrialCatalog(){if(!confirm('إضافة 200 مادة تجريبية متنوعة إلى المخزن الحالي؟ لن تُحذف الأصناف الموجودة.'))return;try{const r=await fetch('/market-trial-catalog.json',{cache:'no-store'});if(!r.ok)throw new Error('تعذر تحميل قائمة التجربة');const rows=await r.json(),catalog=marketCatalog();let added=0;for(const row of rows){if(!catalog.some(x=>x.id===row.id||String(x.barcode)===String(row.barcode))){catalog.push(row);added++}}localStorage.setItem(marketCatalogKey,JSON.stringify(catalog));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',new Date().toISOString());await window.AlMahasibMarketOffline.saveSnapshot('trial-catalog');renderMarketCatalog();const status=document.getElementById('cashierActionStatus');if(status)status.textContent='أضيفت '+added+' مادة للتجربة؛ اضغط مزامنة الآن';}catch(e){alert(e.message)}}
  function marketWorkKey(){return 'tenant:'+companyScope+':market_work_'+marketCashierId()+'_v1'}
  function saveMarketWork(){if(selectedMode!=='market'||!standaloneCashier)return;localStorage.setItem(marketWorkKey(),JSON.stringify({cart,activeHeldMarketId,marketReceivedManual,discount:document.getElementById('discountInput')?.value||'0',received:document.getElementById('marketReceived')?.value||'0',paymentType:document.getElementById('marketPaymentType')?.value||'cash',party:document.getElementById('marketParty')?.value||'',localReceipt,scannerToken:marketScannerToken,scannerShiftId:getMarketShift()?.id}))}
  function restoreMarketWork(){try{const x=JSON.parse(localStorage.getItem(marketWorkKey())||'null');if(!x)return;cart=Array.isArray(x.cart)?x.cart:[];activeHeldMarketId=x.activeHeldMarketId||null;marketReceivedManual=!!x.marketReceivedManual;document.getElementById('discountInput').value=x.discount||'0';const received=document.getElementById('marketReceived');if(received)received.value=x.received||'0';const type=document.getElementById('marketPaymentType');if(type)type.value=x.paymentType||'cash';const party=document.getElementById('marketParty');if(party)party.value=x.party||'';localReceipt=x.localReceipt;paymentTypeChanged(false);renderCart();if(x.scannerToken&&x.scannerShiftId===getMarketShift()?.id&&getMarketShift()?.status==='open'){marketScannerToken=x.scannerToken;clearInterval(marketScannerTimer);marketScannerTimer=setInterval(pollPhoneScanner,350);saveMarketWork()}}catch{}}
  function paymentTypeChanged(reset=true){const type=document.getElementById('marketPaymentType')?.value||'cash',party=document.getElementById('marketParty'),received=document.getElementById('marketReceived');if(party)party.placeholder=type==='representative'?'اسم المندوب':'اسم العميل';if(reset){marketReceivedManual=type!=='cash';if(received&&type!=='cash')received.value='0'}renderCart();saveMarketWork()}
  async function manualMarketSync(){const button=document.getElementById('marketManualSync');if(button)button.disabled=true;const status=document.getElementById('cashierActionStatus');try{if(status)status.textContent='جارٍ المزامنة…';await window.MarketCashierLedger.sync();if(status)status.textContent='تمت المزامنة';renderMarketShift();showHeldMarketSales()}catch(e){if(status)status.textContent=e.message}finally{if(button)button.disabled=false}}
  async function marketCashIn(){const shift=getMarketShift();if(!shift||shift.status!=='open')return alert('افتح الشفت أولًا');try{const title=document.getElementById('marketCashInTitle').value.trim(),input=document.getElementById('marketCashInAmount'),amount=normalize(input.value||'0');if(!title||toScaled(amount)<=0n)throw new Error('أدخل بيان المبلغ وقيمة أكبر من صفر');window.MarketCashierLedger.record('cash_in',{title,amount,shiftId:shift.id,cashier:shift.cashier,cashierCode:marketCashierId()});await window.MarketCashierLedger.flush();input.value='';document.getElementById('marketCashInTitle').value='';renderMarketShift()}catch(e){alert(e.message)}}
  function showReceivable(number){const invoice=window.MarketCashierLedger.receivables().find(x=>x.number===number);if(!invoice)return;document.getElementById('receivableDialog')?.remove();const dialog=document.createElement('dialog');dialog.id='receivableDialog';dialog.style.cssText='max-width:520px;width:95%;border:0;border-radius:18px;padding:24px';dialog.innerHTML='<h2>'+escapeHtml(invoice.party||'حساب آجل')+'</h2><p>الفاتورة: '+escapeHtml(number)+'</p><p>المتبقي: '+Number(invoice.balance).toLocaleString('ar-IQ')+' د.ع</p><div>'+invoice.lines.map(x=>'<p>'+escapeHtml(x.name)+' — '+escapeHtml(x.quantity)+' × '+escapeHtml(x.unitPrice)+'</p>').join('')+'</div><label>المبلغ المقبوض الآن <input id="receivableAmount" type="number" min="0" step="0.000001" value="'+escapeHtml(String(Number(invoice.balance)))+'"></label><p id="receivableError" style="color:#b42318"></p><button class="btn btn-success" id="collectReceivable">تسجيل التحصيل</button> <button class="btn" id="closeReceivable">رجوع</button>';document.body.append(dialog);dialog.querySelector('#closeReceivable').onclick=()=>dialog.remove();dialog.querySelector('#collectReceivable').onclick=async function(){this.disabled=true;try{const shift=getMarketShift();await window.MarketCashierLedger.collect(number,normalize(dialog.querySelector('#receivableAmount').value),{...shift,cashierCode:marketCashierId()});dialog.remove();renderMarketShift();showHeldMarketSales()}catch(e){dialog.querySelector('#receivableError').textContent=e.message;this.disabled=false}};dialog.showModal()}
  async function backupMarketCashier(){try{const data=await window.MarketCashierLedger.backup(),blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='AlMahasibPro-Backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){alert(e.message)}}
  async function restoreMarketBackup(file){if(!file)return;try{const data=JSON.parse(await file.text());if(!confirm('استعادة النسخة لهذه الشركة؟ ستُدمج السجلات دون حذف البيانات الحالية.'))return;await window.MarketCashierLedger.restoreBackup(data);restoreMarketWork();renderMarketShift();showHeldMarketSales();renderMarketCatalog()}catch(e){alert(e.message)}}
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
    const titleInput=document.getElementById('marketExpenseTitle'),amountInput=document.getElementById('marketExpenseAmount');
    const title=String(titleInput?titleInput.value:prompt('بيان المصروف:')||'').trim();if(!title)return alert('أدخل بيان المصروف');const amount=Number(amountInput?amountInput.value:prompt('المبلغ:','0')||0);if(!Number.isFinite(amount)||!(amount>0))return alert('أدخل مبلغ مصروف صحيح');
    const expense={id:crypto.randomUUID(),title,amount,at:new Date().toISOString()};s.expenses=s.expenses||[];s.expenses.push(expense);localStorage.setItem(marketShiftKey(),JSON.stringify(s));window.AlMahasibMarketOffline?.queueTransaction('expense',{id:expense.id,shiftId:s.id,cashier:s.cashier,cashierCode:marketCashierId(),title,amount,occurredAt:expense.at});if(titleInput)titleInput.value='';if(amountInput)amountInput.value='';renderMarketShift();
  }
  function marketShiftSummary(s=getMarketShift()){
    if(!s)return null;const inShift=x=>x.shiftId?x.shiftId===s.id:(x.cashierCode===marketCashierId()||(!x.cashierCode&&x.cashier===s.cashier))&&new Date(x.at)>=new Date(s.openedAt)&&(!s.closedAt||new Date(x.at)<=new Date(s.closedAt));const invoices=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]').filter(inShift);
    const returns=JSON.parse(localStorage.getItem(marketReturnsKey())||'[]').filter(inShift);
    const valid=invoices.filter(x=>!x.cancelled),sales=invoices.reduce((n,x)=>n+Number(x.net||0),0),returnAmount=returns.reduce((n,x)=>n+Number(x.amount||0),0),cancelled=invoices.filter(x=>x.cancelled).reduce((n,x)=>n+Number(x.net||0),0),expenses=(s.expenses||[]).reduce((n,x)=>n+Number(x.amount||0),0);
    const cashRefunds=returns.reduce((n,x)=>n+Number(x.cashRefund??x.amount??0),0);const cashSales=valid.reduce((n,x)=>n+Number(x.cash??x.net??0),0),creditSales=valid.reduce((n,x)=>n+Number(x.due||0),0),movements=window.MarketCashierLedger?.cashForShift(s.id)||{cashIn:0,collections:0};return {invoices,valid,returned:returns,sales,returns:returnAmount,cancelled,expenses,cashSales,creditSales,...movements,expected:Number(s.opening||0)+cashSales+movements.cashIn+movements.collections-cashRefunds-expenses};
  }
  function printMarketStatement(){
    const s=getMarketShift();if(!s)return alert('لا يوجد شفت حالي');const m=marketShiftSummary(s),company=companyContext.name||'الشركة';
    const w=open('','_blank');if(!w)return alert('اسمح بفتح نافذة الكشف للطباعة');w.document.write('<html dir="rtl"><head><title>كشف الصندوق</title><style>body{font-family:Arial;padding:28px;color:#000}h1{text-align:center}table{width:100%;border-collapse:collapse}td,th{border:1px solid #777;padding:7px}.sum{font-size:18px;line-height:2}</style></head><body><h1>'+escapeHtml(company)+'</h1><h2>كشف الصندوق / الشفت</h2><p>الكاشير: '+escapeHtml(s.cashier)+'</p><p>فتح: '+new Date(s.openedAt).toLocaleString('ar-IQ')+(s.closedAt?' — إغلاق: '+new Date(s.closedAt).toLocaleString('ar-IQ'):'')+'</p><div class="sum">الرصيد الافتتاحي: '+s.opening.toLocaleString('ar-IQ')+' د.ع<br>المبيعات: '+m.sales.toLocaleString('ar-IQ')+' د.ع<br>المقبوض من البيع: '+m.cashSales.toLocaleString('ar-IQ')+' د.ع<br>البيع غير المقبوض: '+m.creditSales.toLocaleString('ar-IQ')+' د.ع<br>المبالغ المضافة للصندوق: '+m.cashIn.toLocaleString('ar-IQ')+' د.ع<br>تحصيل الآجل والمندوبين: '+m.collections.toLocaleString('ar-IQ')+' د.ع<br>المرتجعات: '+m.returns.toLocaleString('ar-IQ')+' د.ع<br>الإلغاءات: '+m.cancelled.toLocaleString('ar-IQ')+' د.ع<br>المصروفات: '+m.expenses.toLocaleString('ar-IQ')+' د.ع<br><b>النقد المتوقع: '+m.expected.toLocaleString('ar-IQ')+' د.ع</b>'+(s.counted!=null?'<br>النقد الفعلي: '+Number(s.counted).toLocaleString('ar-IQ')+' د.ع<br>فرق الصندوق: '+Number(s.difference).toLocaleString('ar-IQ')+' د.ع':'')+'</div><h3>الفواتير</h3><table><tr><th>الرقم</th><th>الوقت</th><th>الصافي</th><th>الحالة</th></tr>'+m.invoices.map(x=>'<tr><td>'+escapeHtml(x.number)+'</td><td>'+new Date(x.at).toLocaleString('ar-IQ')+'</td><td>'+Number(x.net||0).toLocaleString('ar-IQ')+'</td><td>'+(x.cancelled?'ملغاة':x.returned?'مرتجع':'بيع')+'</td></tr>').join('')+'</table><h3>المصروفات</h3><table><tr><th>البيان</th><th>المبلغ</th><th>الوقت</th></tr>'+(s.expenses||[]).map(x=>'<tr><td>'+escapeHtml(x.title)+'</td><td>'+Number(x.amount).toLocaleString('ar-IQ')+'</td><td>'+new Date(x.at).toLocaleString('ar-IQ')+'</td></tr>').join('')+'</table><h3>حركات دخول الصندوق والتحصيل</h3><table><tr><th>الحركة</th><th>البيان / الحساب</th><th>الفاتورة</th><th>المبلغ</th><th>الوقت</th></tr>'+((window.MarketCashierLedger?.read('cash_movements')||[]).filter(x=>x.shiftId===s.id&&x.state!=='rejected').map(x=>'<tr><td>'+(x.kind==='cash_in'?'إضافة للصندوق':'تحصيل')+'</td><td>'+escapeHtml(x.title||x.party||'')+'</td><td>'+escapeHtml(x.invoice||'')+'</td><td>'+Number(x.amount).toLocaleString('ar-IQ')+'</td><td>'+new Date(x.occurredAt).toLocaleString('ar-IQ')+'</td></tr>').join(''))+'</table><h3>فتح الصندوق بدون بيع — F7</h3><table><tr><th>العملية</th><th>الوقت</th><th>المبلغ</th><th>الإرسال</th></tr>'+((window.MarketCashierLedger?.read('drawer_events')||[]).filter(x=>x.shiftId===s.id&&x.kind==='drawer_open').map(x=>{const result=(window.MarketCashierLedger.read('drawer_events')||[]).find(y=>y.requestId===x.id);return '<tr><td>F7</td><td>'+new Date(x.occurredAt).toLocaleString('ar-IQ')+'</td><td></td><td>'+(result?.status==='sent'?'أُرسل أمر الفتح':result?.status==='failed'?'تعذر الإرسال':'بانتظار الإرسال')+'</td></tr>'}).join(''))+'</table><br><p>توقيع الكاشير: ____________ &nbsp;&nbsp; توقيع المستلم: ____________</p></body></html>');w.document.close();w.print();
  }
  async function closeMarketShift(handover=false){
    const s=getMarketShift();if(!s||s.status!=='open')return alert('لا يوجد شفت مفتوح');const m=marketShiftSummary(s),answer=prompt('النقد الفعلي في الصندوق:',String(m.expected));if(answer===null)return;const counted=Number(answer);if(!Number.isFinite(counted)||counted<0)return alert('أدخل مبلغًا صحيحًا');
    if(navigator.onLine){try{await disconnectPhoneScanner(s.id)}catch(e){return alert('تعذر إيقاف الماسح. أعد المحاولة قبل إغلاق الشفت.')}}
    s.status='closed';s.closedAt=new Date().toISOString();s.counted=counted;s.difference=counted-m.expected;s.closeType=handover?'handover':'close';
    const h=JSON.parse(localStorage.getItem(marketShiftHistoryKey())||'[]');h.unshift({...s,summary:m});localStorage.setItem(marketShiftHistoryKey(),JSON.stringify(h));localStorage.setItem(marketShiftKey(),JSON.stringify(s));window.AlMahasibMarketOffline?.queueTransaction('shift_close',{id:crypto.randomUUID(),shiftId:s.id,cashier:s.cashier,cashierCode:marketCashierId(),opening:s.opening,counted:s.counted,difference:s.difference,closeType:s.closeType,summary:m,occurredAt:s.closedAt});renderMarketShift();
    alert((handover?'تم تسليم الشفت':'تم إغلاق وتسوية الشفت')+'\nفرق الصندوق: '+s.difference.toLocaleString('ar-IQ')+' د.ع');
  }
  function renderMarketSalesTotal(){const el=document.getElementById('marketShiftSalesTotal');if(!el)return;const s=getMarketShift();const rows=s?JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]').filter(x=>!x.cancelled&&(x.shiftId?x.shiftId===s.id:(x.cashierCode===marketCashierId()||(!x.cashierCode&&x.cashier===s.cashier))&&new Date(x.at)>=new Date(s.openedAt)&&(!s.closedAt||new Date(x.at)<=new Date(s.closedAt)))):[];const total=rows.reduce((sum,x)=>sum+toScaled(normalize(x.net||'0')),0n);el.textContent=Number(fromScaled(total)).toLocaleString('ar-IQ')+' د.ع';const count=document.getElementById('marketShiftSalesCount');if(count)count.textContent=rows.length+' فاتورة مكتملة';}
  function renderMarketShift(){if(selectedMode!=='market')return;updateMarketCashierLabel();renderMarketSalesTotal();const currentSummary=marketShiftSummary();for(const [id,value] of [['marketExpectedCash',currentSummary?.expected||0],['marketCashInTotal',currentSummary?.cashIn||0],['marketCollectionsTotal',currentSummary?.collections||0]]){const node=document.getElementById(id);if(node)node.textContent=Number(value).toLocaleString('ar-IQ')+' د.ع'}const expenseTotal=document.getElementById('marketExpenseTotal');if(expenseTotal)expenseTotal.textContent=Number((getMarketShift()?.expenses||[]).reduce((n,x)=>n+Number(x.amount||0),0)).toLocaleString('ar-IQ')+' د.ع';const s=getMarketShift(),el=document.getElementById('marketShiftInfo');if(!el)return;el.textContent=!s?'لا يوجد شفت مفتوح':s.status==='open'?'الشفت مفتوح منذ '+new Date(s.openedAt).toLocaleTimeString('ar-IQ'):'آخر شفت مغلق — فرق الصندوق '+Number(s.difference||0).toLocaleString('ar-IQ')+' د.ع';}
  function loadHeldMarketSales(){try{return JSON.parse(localStorage.getItem(marketHeldKey())||'[]')}catch{return[]}}
  function storeHeldMarketDraft(id,ref){
    const a=loadHeldMarketSales(),old=a.find(x=>x.id===id);
    const draft={id,ref,paymentType:document.getElementById('marketPaymentType')?.value||'cash',party:document.getElementById('marketParty')?.value||'',at:old?.at||new Date().toISOString(),updatedAt:new Date().toISOString(),cart:structuredClone(cart),discount:document.getElementById('discountInput').value||'0',received:document.getElementById('marketReceived')?.value||'0',receivedManual:marketReceivedManual};
    const index=a.findIndex(x=>x.id===id);if(index<0)a.unshift(draft);else a[index]=draft;
    localStorage.setItem(marketHeldKey(),JSON.stringify(a));
    if(!old||JSON.stringify([old.cart,old.discount,old.received,old.receivedManual,old.party||'',old.paymentType||'cash',old.ref])!==JSON.stringify([draft.cart,draft.discount,draft.received,draft.receivedManual,draft.party,draft.paymentType,draft.ref]))window.MarketCashierLedger?.record('waiting_update',{waitingId:id,draft});
  }
  function holdMarketSale(){
    if(saleInProgress)return;
    if(!cart.length)return alert('لا توجد مواد لتعليقها');
    const a=loadHeldMarketSales(),old=a.find(x=>x.id===activeHeldMarketId);
    let next=1;while(a.some(x=>x.ref==='انتظار '+next))next+=1;
    const ref=old?.ref||('انتظار '+next);
    storeHeldMarketDraft(activeHeldMarketId||crypto.randomUUID(),ref.trim()||old?.ref||('انتظار '+(a.length+1)));
    activeHeldMarketId=null;cart=[];marketReceivedManual=false;document.getElementById('discountInput').value='0';const nextParty=document.getElementById('marketParty');if(nextParty)nextParty.value='';const nextType=document.getElementById('marketPaymentType');if(nextType)nextType.value='cash';renderCart();showHeldMarketSales();
  }
  function showHeldMarketSales(){
    const el=document.getElementById('marketHeldList');if(!el)return;
    const a=loadHeldMarketSales(),due=window.MarketCashierLedger?.receivables()||[];el.style.display='block';
    el.innerHTML='<h3>فواتير الانتظار</h3><div class="held-market-grid">'+(a.length?a.map(x=>{
      const lines=x.cart||[],total=lines.reduce((sum,l)=>sum+toScaled(multiply(l.quantity,l.unitPrice)),0n)-toScaled(x.discount||'0');
      return '<article class="held-market-card'+(x.id===activeHeldMarketId?' editing':'')+'"><b>'+escapeHtml(x.ref)+'</b><small>'+escapeHtml(new Date(x.updatedAt||x.at).toLocaleString('ar-IQ'))+'</small><p>'+lines.length+' أصناف — '+Number(fromScaled(total>0n?total:0n)).toLocaleString('ar-IQ')+' د.ع</p><div class="actions"><button class="btn btn-primary" data-held-open="'+escapeHtml(x.id)+'">'+(x.id===activeHeldMarketId?'قيد الإضافة':'فتح وإضافة مواد')+'</button><button class="btn btn-danger" data-held-delete="'+escapeHtml(x.id)+'">حذف</button></div></article>';
    }).join(''):'<p class="muted">لا توجد فواتير معلّقة</p>')+due.map(x=>'<article class="held-market-card"><b>'+escapeHtml(x.party||x.number)+'</b><small>'+(x.paymentType==='representative'?'عهدة مندوب':'بيع آجل')+' — '+escapeHtml(x.number)+'</small><p>المتبقي: '+Number(x.balance).toLocaleString('ar-IQ')+' د.ع</p><button class="btn btn-success" data-receivable="'+escapeHtml(x.number)+'">عرض وتصفية الحساب</button></article>').join('')+'</div>';
    el.onclick=(event)=>{const open=event.target.closest('[data-held-open]'),remove=event.target.closest('[data-held-delete]');const debt=event.target.closest('[data-receivable]');if(debt)showReceivable(debt.dataset.receivable);if(open)restoreHeldMarketSale(open.dataset.heldOpen);if(remove)deleteHeldMarketSale(remove.dataset.heldDelete)};
    const label=document.getElementById('activeInvoiceLabel');if(label)label.textContent=activeHeldMarketId?'إضافة إلى: '+(a.find(x=>x.id===activeHeldMarketId)?.ref||'فاتورة انتظار'):'فاتورة جديدة';
  }
  function restoreHeldMarketSale(id){
    if(saleInProgress||id===activeHeldMarketId)return;
    const a=loadHeldMarketSales(),x=a.find(z=>z.id===id);if(!x)return;
    const catalog=marketCatalog(),bad=(x.cart||[]).find(l=>{const stock=catalog.find(z=>z.id===l.itemId);return !stock||Number(stock.qty||0)<Number(l.quantity||0)});
    if(bad)return alert('لا يمكن الفتح: رصيد الصنف غير كافٍ أو تم حذفه: '+bad.name);
    if(cart.length&&!activeHeldMarketId){if(!confirm('حفظ الفاتورة الحالية بالانتظار وفتح الفاتورة المختارة؟'))return;storeHeldMarketDraft(crypto.randomUUID(),'انتظار '+(a.length+1))}
    if(activeHeldMarketId){const old=a.find(z=>z.id===activeHeldMarketId);if(old)storeHeldMarketDraft(activeHeldMarketId,old.ref)}
    activeHeldMarketId=id;cart=structuredClone(x.cart||[]);const type=document.getElementById('marketPaymentType');if(type)type.value=x.paymentType||'cash';const party=document.getElementById('marketParty');if(party)party.value=x.party||'';document.getElementById('discountInput').value=x.discount||'0';
    marketReceivedManual=!!x.receivedManual;const received=document.getElementById('marketReceived');if(received)received.value=x.received||'0';
    renderCart();showHeldMarketSales();document.getElementById('barcodeInput').focus();
  }
  function deleteHeldMarketSale(id){
    if(saleInProgress||!confirm('حذف فاتورة الانتظار؟'))return;
    const a=loadHeldMarketSales().filter(z=>z.id!==id);localStorage.setItem(marketHeldKey(),JSON.stringify(a));window.MarketCashierLedger?.record('waiting_close',{waitingId:id});
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
    const returnRow={id:crypto.randomUUID(),invoice:number,reason,lines:selected.map(z=>z.line),amount,at:new Date().toISOString(),cashier:marketCashierName(),cashierCode:marketCashierId(),shiftId:getMarketShift()?.id||null,cashRefund:Math.max(0,amount-Number(window.MarketCashierLedger?.amount(window.MarketCashierLedger.remaining(x))||0))};
    if(navigator.onLine){const rr=await fetch('/api/v1/market/stock-reversal',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...returnRow,kind:'return'})});const body=await rr.json().catch(()=>({}));if(!rr.ok)return alert(body?.error?.message||'تعذر اعتماد المرتجع مركزيًا');cat=body.snapshot.catalog;localStorage.setItem(marketCatalogKey,JSON.stringify(cat));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',body.snapshot.updatedAt);await window.AlMahasibMarketOffline?.saveLocalSnapshot(cat,body.snapshot.updatedAt)}else{selected.forEach(({line})=>{const item=cat.find(z=>z.id===line.itemId);if(item)item.qty=Number(item.qty||0)+Number(line.quantity||0)});localStorage.setItem(marketCatalogKey,JSON.stringify(cat));localStorage.setItem('tenant:'+companyScope+':market_catalog_updated_at',returnRow.at);await window.AlMahasibMarketOffline?.queueTransaction('return',{...returnRow,occurredAt:returnRow.at});await window.AlMahasibMarketOffline?.saveSnapshot('market-return')}
    const returns=JSON.parse(localStorage.getItem(marketReturnsKey())||'[]');returns.unshift(returnRow);localStorage.setItem(marketReturnsKey(),JSON.stringify(returns));
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
        const paymentType=document.getElementById('marketPaymentType')?.value||'cash',party=document.getElementById('marketParty')?.value.trim()||'';if(paymentType!=='cash'&&!party)throw new Error('أدخل اسم العميل أو المندوب');if(paymentType==='cash'&&toScaled(received)<toScaled(net))throw new Error('المبلغ المستلم أقل من صافي الفاتورة');const cash=fromScaled(toScaled(received)>toScaled(net)?toScaled(net):toScaled(received)),due=fromScaled(toScaled(net)-toScaled(cash));
        let catalog=marketCatalog();
        for(const l of cart){const x=catalog.find(z=>z.id===l.itemId);if(!x)throw new Error('أحد الأصناف غير موجود');if(Number(x.qty||0)<Number(l.quantity||0))throw new Error('الرصيد غير كافٍ للصنف: '+l.name)}
        const number='MKT-'+Date.now()+'-'+crypto.randomUUID().slice(0,6),saleId=crypto.randomUUID(),saleAt=new Date().toISOString();
        const salePayload={id:saleId,invoice:number,shiftId:shift.id,cashier:shift.cashier,cashierCode:marketCashierId(),gross:fromScaled(gross),discount,net,cash,due,paymentType,party,heldId:activeHeldMarketId,received,change:fromScaled(toScaled(received)>toScaled(net)?toScaled(received)-toScaled(net):0n),lines:structuredClone(cart),occurredAt:saleAt};
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
        localReceipt={number,lines:structuredClone(cart),gross:fromScaled(gross),discount,net,cash,due,paymentType,party,received,change:salePayload.change,mode:titles[selectedMode],at:saleAt,returned:false,cancelled:false,cashier:shift.cashier,cashierCode:marketCashierId(),shiftId:shift.id};
        const invoices=JSON.parse(localStorage.getItem(marketInvoicesKey())||'[]');invoices.unshift(localReceipt);localStorage.setItem(marketInvoicesKey(),JSON.stringify(invoices));
        if(activeHeldMarketId){window.MarketCashierLedger?.record('waiting_close',{waitingId:activeHeldMarketId});localStorage.setItem(marketHeldKey(),JSON.stringify(loadHeldMarketSales().filter(x=>x.id!==activeHeldMarketId)));activeHeldMarketId=null;}
        renderMarketCatalog();renderReceipt(localReceipt);cart=[];document.getElementById('discountInput').value='0';const nextParty=document.getElementById('marketParty');if(nextParty)nextParty.value='';const nextType=document.getElementById('marketPaymentType');if(nextType)nextType.value='cash';renderCart();if(standaloneCashier)showHeldMarketSales();const r=document.getElementById('marketReceived');if(r)r.value='0';updateMarketChange();
        renderMarketSalesTotal();renderMarketShift();saveMarketWork();if(printAfter){if(cashDrawerPort?.writable)void pulseCashDrawer().catch(error=>alert('تم حفظ البيع؛ تعذر فتح الصندوق: '+error.message));saleInProgress=false;if(checkoutButton)checkoutButton.disabled=false;printReceipt();}document.getElementById('barcodeInput').focus();return;
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

  let cashDrawerPort=null,drawerBusy=false;
  async function connectCashDrawer(){
    try{
      if(!navigator.serial)throw new Error('ربط الصندوق المباشر يحتاج Chrome ومنفذ طابعة حرارية تسلسلي ESC/POS');
      const port=await navigator.serial.requestPort();await port.open({baudRate:9600});cashDrawerPort=port;
      const status=document.getElementById('cashDrawerStatus');if(status)status.textContent='منفذ الصندوق مرتبط';
    }catch(error){alert(error.message)}
  }
  async function pulseCashDrawer(){
    if(!cashDrawerPort?.writable)throw new Error('اربط منفذ الصندوق أولًا. فتح الصندوق عند طباعة F8 يمكن تفعيله من إعدادات الطابعة؛ F7 يحتاج ربطًا مباشرًا.');
    const writer=cashDrawerPort.writable.getWriter();try{await writer.write(new Uint8Array([27,112,0,50,250]))}finally{writer.releaseLock()}
  }
  async function openCashDrawerOnly(){
    if(drawerBusy||saleInProgress)return;drawerBusy=true;
    try{
      const shift=getMarketShift();if(!shift||shift.status!=='open')throw new Error('افتح الشفت أولًا');
      // Record before dispatch; failure remains visible and never affects cash totals.
      if(!cashDrawerPort?.writable)throw new Error('اربط منفذ الصندوق أولًا باستخدام زر ربط الصندوق');
      const event=window.MarketCashierLedger.record('drawer_open',{key:'F7',shiftId:shift.id,cashier:shift.cashier,cashierCode:marketCashierId(),status:'requested'});
      try{await pulseCashDrawer();window.MarketCashierLedger.record('drawer_result',{requestId:event.id,status:'sent',shiftId:shift.id})}
      catch(error){window.MarketCashierLedger.record('drawer_result',{requestId:event.id,status:'failed',shiftId:shift.id});throw error}
    }catch(error){alert(error.message)}finally{drawerBusy=false}
  }
  document.addEventListener('keydown',event=>{
    if(selectedMode!=='market'||event.ctrlKey||event.altKey||event.metaKey||!['F7','F8'].includes(event.key))return;
    event.preventDefault();if(event.repeat||document.querySelector('dialog[open]'))return;
    if(event.key==='F7')void openCashDrawerOnly();else void completeSale(true);
  });

  let receiptPrintQueue = Promise.resolve();
  function printReceipt() {
    if (!localReceipt && state?.lastReceipt) renderReceipt(state.lastReceipt.payload.document);
    const html = document.getElementById('receipt').innerHTML;
    if (!html) return alert('لا يوجد وصل للطباعة');
    // Capture now: a subsequent sale must never replace a queued receipt.
    receiptPrintQueue = receiptPrintQueue.catch(() => {}).then(() => new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.title = 'وصل حراري';
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:302px;height:1px;border:0';
      document.body.appendChild(frame);
      const doc = frame.contentDocument;
      doc.open();
      doc.write('<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>@page{size:80mm 200mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:white;color:black}body{width:80mm;padding:3mm;font:11px Arial,sans-serif}h2{font-size:16px}table{table-layout:fixed}th,td{font-size:10px;padding:3px 1px;border-bottom:1px solid #ddd;white-space:normal;overflow-wrap:anywhere}th:first-child,td:first-child{width:40%}p{margin:6px 0}hr{border:0;border-top:1px dashed black}</style></head><body>'+html+'</body></html>');
      doc.close();
      let finished = false;
      const finish = () => { if(finished)return;finished=true;frame.remove();resolve(); };
      frame.contentWindow.addEventListener('afterprint',finish,{once:true});
      const ready = doc.fonts?.ready || Promise.resolve();
      ready.then(() => setTimeout(() => {
        const height = Math.max(40, Math.ceil(doc.body.scrollHeight * 25.4 / 96) + 3);
        const style=doc.createElement('style');style.textContent='@page{size:80mm '+height+'mm;margin:0}';doc.head.appendChild(style);
        try { frame.contentWindow.focus();frame.contentWindow.print(); }
        catch(error){finish();alert('تعذرت الطباعة: '+error.message);return;}
        // Chromium emits afterprint when printing or cancellation completes.
      },0));
    }));
  }

  function renderReceipt(receipt) {
    const receiptNumber = value => escapeHtml(String(value ?? '0').replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'));
    const company=companyContext.name||'المحاسب برو';
    const cashier=receipt.cashier||marketCashierName();
    const lines=receipt.lines||[];
    const net=receipt.net||receipt.subtotal||'0.000000', cash=receipt.cash||'0.000000', due=receipt.due||'0.000000', received=receipt.received||cash, change=receipt.change||'0.000000';
    document.getElementById('receipt').innerHTML =
      '<div style="font-family:Arial;text-align:center;color:#000"><h2 style="margin:0">'+escapeHtml(company)+'</h2>'+
      '<div>'+escapeHtml(receipt.mode||titles[selectedMode])+'</div><div>الكاشير: '+escapeHtml(cashier)+'</div>'+ (receipt.party?'<div>'+(receipt.paymentType==='representative'?'المندوب':'العميل')+': '+escapeHtml(receipt.party)+'</div>':'')+
      '<div>'+new Date(receipt.at||Date.now()).toLocaleString('ar-IQ')+'</div><hr>'+
      '<div style="text-align:right">رقم الفاتورة: <b>'+escapeHtml(receipt.number||receipt.documentNumber||'')+'</b></div>'+
      '<table style="width:100%;border-collapse:collapse;margin-top:8px"><thead><tr><th>المادة</th><th>الكمية</th><th>السعر</th><th>المجموع</th></tr></thead><tbody>'+
      lines.map(l=>'<tr><td>'+escapeHtml(l.name||'مادة')+'</td><td>'+receiptNumber(l.quantity||'1')+'</td><td>'+receiptNumber(l.unitPrice||'0')+'</td><td>'+receiptNumber(multiply(l.quantity||'1',l.unitPrice||'0'))+'</td></tr>').join('')+
      '</tbody></table><hr><div style="text-align:right"><div>الإجمالي: '+receiptNumber(receipt.gross||net)+' د.ع</div>'+
      '<div>الخصم: '+receiptNumber(receipt.discount||'0')+' د.ع</div><div><b>الصافي: '+receiptNumber(net)+' د.ع</b></div>'+
      '<div>المدفوع: '+receiptNumber(cash)+' د.ع</div>'+(selectedMode==='market'?'<div>المستلم: '+receiptNumber(received)+' د.ع</div><div>الباقي للزبون: '+receiptNumber(change)+' د.ع</div>':'')+'<div>المتبقي/الآجل: '+receiptNumber(due)+' د.ع</div></div>'+
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
      marketScannerToken=b.token;saveMarketWork();const el=document.getElementById('marketScannerStatus');if(el)el.textContent='رمز الهاتف: '+marketScannerToken.slice(0,8);
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
    clearInterval(marketScannerTimer);marketScannerToken=null;saveMarketWork();document.getElementById('scannerPairDialog')?.remove();
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

  window.PosUI = { connectCashDrawer, openCashDrawerOnly, showMarketTrialCatalog, addMarketTrialCatalog, manualMarketSync, marketCashIn, paymentTypeChanged, saveMarketWork, backupMarketCashier, restoreMarketBackup, stopPhoneScanner, scanBarcode, setMarketQty, pairPhoneScanner, cancelMarketInvoice, marketOpenShift, marketExpense, printMarketStatement, closeMarketShift, renderMarketShift, openShift, allocateOffline, completeSale, returnLast, closeShift, printReceipt, reprintMarketInvoice, remove, addProduct, addMarketProduct, changeQty, renderMarketCatalog, holdMarketSale, showHeldMarketSales, restoreHeldMarketSale, deleteHeldMarketSale, updateMarketChange, returnMarketInvoice };
  void initialize();
}());


