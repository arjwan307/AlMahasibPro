(function(){'use strict';
if(new URLSearchParams(location.search).get('mode')!=='restaurant')return;
document.getElementById('restaurantExperience').classList.add('active');document.getElementById('legacyPos').classList.add('hidden-pos');
const seed=[
['كباب عراقي نفر 4 شيش','مشويات',12000,'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?auto=format&fit=crop&w=500&q=80'],
['كباب عراقي نصف نفر 2 شيش','مشويات',6500,'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=500&q=80'],
['كباب عراقي شيش واحد','مشويات',3500,'https://images.unsplash.com/photo-1558030006-450675393462?auto=format&fit=crop&w=500&q=80'],
['تكة لحم نفر 4 شيش','مشويات',16000,'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=500&q=80'],
['تكة لحم نصف نفر 2 شيش','مشويات',8500,'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?auto=format&fit=crop&w=500&q=80'],
['تكة دجاج نفر 4 شيش','مشويات',12000,'https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?auto=format&fit=crop&w=500&q=80'],
['تكة دجاج نصف نفر 2 شيش','مشويات',6500,'https://images.unsplash.com/photo-1532550907401-a500c9a57435?auto=format&fit=crop&w=500&q=80'],
['معلاك مشوي','مشويات',12000,'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=500&q=80'],
['ضلوع مشوية','مشويات',18000,'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=500&q=80'],
['ربع دجاج مشوي','دجاج',6000,'https://images.unsplash.com/photo-1532550907401-a500c9a57435?auto=format&fit=crop&w=500&q=80'],
['نصف دجاج مشوي','دجاج',10000,'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?auto=format&fit=crop&w=500&q=80'],
['دجاجة مشوية كاملة','دجاج',18000,'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?auto=format&fit=crop&w=500&q=80'],
['تمن ومرق بامية','تمن ومرق',7000,'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=500&q=80'],
['تمن ومرق فاصوليا','تمن ومرق',7000,'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=500&q=80'],
['تمن ومرق باذنجان','تمن ومرق',7000,'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=500&q=80'],
['تمن ومرق دجاج','تمن ومرق',9000,'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=500&q=80'],
['سمك مقلي مع تمن','أسماك',15000,'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?auto=format&fit=crop&w=500&q=80'],
['سمك مسكوف','أسماك',22000,'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?auto=format&fit=crop&w=500&q=80'],
['دولمة عراقية','أكلات عراقية',12000,'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=500&q=80'],
['قوزي','أكلات عراقية',15000,'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=500&q=80'],
['برغر لحم','وجبات سريعة',9000,'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=500&q=80'],
['برغر دجاج','وجبات سريعة',8000,'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=500&q=80'],
['زنجر','وجبات سريعة',8000,'https://images.unsplash.com/photo-1615297928064-24977384d0da?auto=format&fit=crop&w=500&q=80'],
['شاورما دجاج','وجبات سريعة',5000,'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?auto=format&fit=crop&w=500&q=80'],
['بيتزا لحم','وجبات سريعة',11000,'https://images.unsplash.com/photo-1579751626657-72bc17010498?auto=format&fit=crop&w=500&q=80'],
['بيتزا دجاج','وجبات سريعة',10000,'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=500&q=80'],
['بطاطا مقلية','وجبات سريعة',3000,'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=500&q=80'],
['شاي عراقي','مشروبات ساخنة',1500,'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=500&q=80'],
['كابتشينو','مشروبات ساخنة',4000,'https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&w=500&q=80'],
['عصير برتقال طبيعي','عصائر طبيعية',5000,'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=500&q=80'],
['موهيتو','مشروبات باردة',5000,'https://images.unsplash.com/photo-1551538827-9c037cb4f32a?auto=format&fit=crop&w=500&q=80'],
['آيس كريم','آيس كريم',4000,'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=500&q=80'],
['أركيلة تفاحتين','أركيلة',10000,'https://images.unsplash.com/photo-1525268323446-0505b6fe7778?auto=format&fit=crop&w=500&q=80'],
['مشاوي مشكلة نفر','مشويات',15000,'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?auto=format&fit=crop&w=500&q=80'],
['أجنحة دجاج مشوية','مشويات',9000,'https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?auto=format&fit=crop&w=500&q=80'],
['عرايس لحم','مشويات',7000,'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?auto=format&fit=crop&w=500&q=80'],
['تشريب لحم','أكلات عراقية',10000,'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=500&q=80'],
['تشريب دجاج','أكلات عراقية',9000,'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=500&q=80'],
['برياني دجاج','أكلات عراقية',9000,'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=500&q=80'],
['مقلوبة لحم','أكلات عراقية',12000,'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=500&q=80'],
['كبة مقلية','مقبلات',5000,'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=500&q=80'],
['حمص بطحينية','مقبلات',3500,'https://images.unsplash.com/photo-1577805947697-89e18249d767?auto=format&fit=crop&w=500&q=80'],
['متبل','مقبلات',3500,'https://images.unsplash.com/photo-1577805947697-89e18249d767?auto=format&fit=crop&w=500&q=80'],
['تبولة','سلطات',4000,'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=500&q=80'],
['سلطة خضراء','سلطات',3000,'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=500&q=80'],
['شوربة عدس','شوربات',3000,'https://images.unsplash.com/photo-1547592166-23ac45744acd?auto=format&fit=crop&w=500&q=80'],
['فلافل صمون','وجبات سريعة',2000,'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?auto=format&fit=crop&w=500&q=80'],
['شاورما لحم','وجبات سريعة',6000,'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?auto=format&fit=crop&w=500&q=80'],
['صاج دجاج','وجبات سريعة',6000,'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?auto=format&fit=crop&w=500&q=80'],
['كلوب ساندويش','وجبات سريعة',7000,'https://images.unsplash.com/photo-1553909489-cd47e0907980?auto=format&fit=crop&w=500&q=80'],
['ناجت دجاج','وجبات سريعة',6500,'https://images.unsplash.com/photo-1562967914-608f82629710?auto=format&fit=crop&w=500&q=80'],
['اسبريسو','كافيه',3000,'https://images.unsplash.com/photo-1510707577719-ae7c14805e3a?auto=format&fit=crop&w=500&q=80'],
['قهوة تركية','كافيه',3000,'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=500&q=80'],
['لاتيه','كافيه',4500,'https://images.unsplash.com/photo-1561882468-9110e03e0f78?auto=format&fit=crop&w=500&q=80'],
['أمريكانو','كافيه',3500,'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=500&q=80'],
['هوت شوكليت','كافيه',4500,'https://images.unsplash.com/photo-1542990253-0d0f5be5f0ed?auto=format&fit=crop&w=500&q=80'],
['عصير رمان طبيعي','عصائر طبيعية',5000,'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=500&q=80'],
['عصير ليمون ونعناع','عصائر طبيعية',4500,'https://images.unsplash.com/photo-1551538827-9c037cb4f32a?auto=format&fit=crop&w=500&q=80'],
['ميلك شيك أوريو','كافيه',6000,'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=500&q=80'],
['ميلك شيك شوكولاتة','كافيه',6000,'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=500&q=80'],
['كنافة','حلويات',5000,'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=500&q=80'],
['بقلاوة','حلويات',4000,'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=500&q=80'],
['آيس كريم شوكولاتة','آيس كريم',4000,'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=500&q=80'],
['آيس كريم فانيلا','آيس كريم',4000,'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=500&q=80'],
['أركيلة عنب ونعناع','أركيلة',10000,'https://images.unsplash.com/photo-1525268323446-0505b6fe7778?auto=format&fit=crop&w=500&q=80'],
['أركيلة ليمون ونعناع','أركيلة',10000,'https://images.unsplash.com/photo-1525268323446-0505b6fe7778?auto=format&fit=crop&w=500&q=80']
];
let menu=JSON.parse(localStorage.getItem('hawa_dijla_menu')||'null')||[];
const seeded=seed.map((x,i)=>({id:'demo-v2-'+i,name:x[0],category:x[1],price:x[2],image:x[3],active:true}));
const existingNames=new Set(menu.map(x=>x.name));
seeded.forEach(x=>{if(!existingNames.has(x.name))menu.push(x)});
let cart=[],cat='الكل',editId=null; const $=id=>document.getElementById(id);
const cashKey='hawa_dijla_cash_shift';
function cashState(){return JSON.parse(localStorage.getItem(cashKey)||'null')||{open:false,cashier:'الكاشير',openedAt:null,opening:0,sales:[],expenses:[]}}
function saveCash(s){localStorage.setItem(cashKey,JSON.stringify(s));renderCash()}
function openCashier(){const s=cashState();if(s.open)return alert('الكاشير مفتوح بالفعل');const opening=Number($('openingCash').value||0);const cashier=prompt('اسم الكاشير',s.cashier||'الكاشير')||'الكاشير';saveCash({open:true,cashier,openedAt:new Date().toISOString(),opening,sales:[],expenses:[]})}
function addExpense(){const s=cashState();if(!s.open)return alert('افتح الكاشير أولاً');const amount=Number($('expenseAmount').value),note=$('expenseNote').value.trim();if(!amount||!note)return alert('أدخل بيان المصروف والمبلغ');s.expenses.push({id:crypto.randomUUID(),note,amount,at:new Date().toISOString()});saveCash(s);$('expenseAmount').value='';$('expenseNote').value=''}
function renderCash(){const s=cashState(),sales=s.sales.reduce((a,x)=>a+x.received,0),expenses=s.expenses.reduce((a,x)=>a+x.amount,0);$('sumOpening').textContent=Number(s.opening).toLocaleString('ar-IQ');$('sumSales').textContent=sales.toLocaleString('ar-IQ');$('sumExpenses').textContent=expenses.toLocaleString('ar-IQ');$('sumFinal').textContent=(s.opening+sales-expenses).toLocaleString('ar-IQ');$('topCashier').textContent=s.cashier||'—';$('topOpened').textContent=s.openedAt?new Date(s.openedAt).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'}):'—';$('topDate').textContent=s.openedAt?new Date(s.openedAt).toLocaleDateString('ar-IQ'):new Date().toLocaleDateString('ar-IQ');$('topOpening').textContent=Number(s.opening).toLocaleString('ar-IQ')+' د.ع'}
function printStatement(){const s=cashState(),sales=s.sales.reduce((a,x)=>a+x.received,0),expenses=s.expenses.reduce((a,x)=>a+x.amount,0),final=s.opening+sales-expenses;const rows=[...s.sales.map(x=>'استلام | '+new Date(x.at).toLocaleString('ar-IQ')+' | '+x.received.toLocaleString('ar-IQ')+' د.ع'),...s.expenses.map(x=>'مصروف: '+x.note+' | '+new Date(x.at).toLocaleString('ar-IQ')+' | '+x.amount.toLocaleString('ar-IQ')+' د.ع')].join('\n');const w=open('','_blank');w.document.write('<pre dir="rtl" style="font:16px sans-serif">هوى دجلة\nكشف الكاشير: '+s.cashier+'\nتاريخ الفتح: '+(s.openedAt?new Date(s.openedAt).toLocaleString('ar-IQ'):'—')+'\nرصيد الافتتاح: '+s.opening.toLocaleString('ar-IQ')+'\nالمبيعات المستلمة: '+sales.toLocaleString('ar-IQ')+'\nالمصروفات: '+expenses.toLocaleString('ar-IQ')+'\nالمجمع النهائي: '+final.toLocaleString('ar-IQ')+'\n\n'+rows+'</pre>');w.document.close();w.print()}
function persist(){localStorage.setItem('hawa_dijla_menu',JSON.stringify(menu))}
function render(){const cats=['الكل',...new Set(menu.map(x=>x.category))];$('categoryTabs').innerHTML=cats.map(x=>'<button class="btn '+(x===cat?'btn-primary':'')+'" data-cat="'+esc(x)+'">'+esc(x)+'</button>').join('');document.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{cat=b.dataset.cat;render()});const q=$('restaurantSearch').value.trim();$('productGrid').innerHTML=menu.filter(x=>x.active&&(cat==='الكل'||x.category===cat)&&(!q||x.name.includes(q))).map(x=>'<article class="product" data-id="'+x.id+'"><img src="'+esc(x.image)+'" alt=""><div class="info"><b>'+esc(x.name)+'</b><div class="price">'+Number(x.price).toLocaleString('ar-IQ')+' د.ع</div></div></article>').join('');document.querySelectorAll('.product').forEach(p=>p.onclick=()=>add(p.dataset.id));renderCart()}
function add(id){const item=menu.find(x=>x.id===id),line=cart.find(x=>x.id===id);if(line)line.qty++;else cart.push({...item,qty:1});renderCart()}
function renderCart(){$('restaurantCart').innerHTML=cart.length?cart.map(x=>'<div class="order-line"><div><b>'+esc(x.name)+'</b><br><small>'+Number(x.price*x.qty).toLocaleString('ar-IQ')+' د.ع</small></div><div class="qty"><button data-minus="'+x.id+'">−</button><b>'+x.qty+'</b><button data-plus="'+x.id+'">+</button></div></div>').join(''):'<p style="color:#64748b">اضغط على صورة أي صنف لإضافته.</p>';$('restaurantTotal').textContent=cart.reduce((s,x)=>s+x.price*x.qty,0).toLocaleString('ar-IQ');document.querySelectorAll('[data-plus]').forEach(b=>b.onclick=()=>{cart.find(x=>x.id===b.dataset.plus).qty++;renderCart()});document.querySelectorAll('[data-minus]').forEach(b=>b.onclick=()=>{const x=cart.find(x=>x.id===b.dataset.minus);x.qty--;if(x.qty<=0)cart=cart.filter(y=>y.id!==x.id);renderCart()})}
function hold(){if(!cart.length)return alert('الطلب فارغ');const table=$('orderReference').value.trim();if(!table)return alert('أدخل رقم الطاولة أولاً');const source=$('orderSource')?$('orderSource').value:'cashier';const captain=source==='captain'&&$('captainName')?$('captainName').value.trim():'';if(source==='captain'&&!captain)return alert('أدخل اسم الكابتن');const ref='طاولة '+table;const orders=JSON.parse(localStorage.getItem('hawa_dijla_orders')||'[]');const current=orders.find(x=>x.status==='open'&&x.ref===ref);const total=cart.reduce((s,x)=>s+x.price*x.qty,0);if(current){current.cart=structuredClone(cart);current.total=total;current.source=source;current.captain=captain;current.at=new Date().toISOString()}else orders.push({id:crypto.randomUUID(),ref,table,cart:structuredClone(cart),total,status:'open',source,captain,at:new Date().toISOString()});localStorage.setItem('hawa_dijla_orders',JSON.stringify(orders));cart=[];$('orderReference').value='';renderCart();showHeld()}
function showHeld(){const o=JSON.parse(localStorage.getItem('hawa_dijla_orders')||'[]').filter(x=>x.status==='open').sort((a,b)=>(Number(a.table)||9999)-(Number(b.table)||9999));$('heldOrders').innerHTML=o.length?'<div class="held-title">الطلبات المفتوحة</div><div class="held-grid">'+o.map(x=>'<button class="btn table-order" data-order="'+x.id+'"><strong>'+esc(x.ref)+'</strong><small>'+Number(x.total).toLocaleString('ar-IQ')+' د.ع</small></button>').join('')+'</div>':'<div class="held-title">لا توجد طلبات مفتوحة</div>';document.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>{const x=o.find(y=>y.id===b.dataset.order);cart=structuredClone(x.cart);$('orderReference').value=x.table||String(x.ref).replace(/[^0-9]/g,'');renderCart()})}
function checkout(){if($('orderSource')&&$('orderSource').value==='captain')return alert('الكابتن يستطيع فتح الطلب وتعديله وإرساله فقط، وإنهاء الحساب من صلاحية الكاشير');if(!cart.length)return alert('الطلب فارغ');const s=cashState();if(!s.open)return alert('افتح الكاشير أولاً');const total=cart.reduce((a,x)=>a+x.price*x.qty,0);$('receivedAmount').value=total;const received=total;const sale={id:crypto.randomUUID(),table:$('orderReference').value.trim(),total,received,change:0,at:new Date().toISOString(),items:structuredClone(cart),drawerOpened:true};s.sales.push(sale);saveCash(s);localStorage.setItem('hawa_dijla_last_drawer_event',JSON.stringify({type:'open-drawer',saleId:sale.id,amount:received,at:sale.at}));window.dispatchEvent(new CustomEvent('restaurant:open-drawer',{detail:{saleId:sale.id,amount:received}}));alert('تم إنهاء الحساب وقيد '+received.toLocaleString('ar-IQ')+' د.ع وفتح الصندوق');cart=[];$('receivedAmount').value='';$('orderReference').value='';renderCart()}
function clear(){cart=[];$('orderReference').value='';renderCart()}
function toggleAdmin(){$('menuAdmin').classList.toggle('hidden-pos')}
function saveItem(){const name=$('menuName').value.trim(),category=$('menuCategory').value.trim(),price=Number($('menuPrice').value);if(!name||!category||!price)return alert('أكمل الاسم والقسم والسعر');const file=$('menuImage').files[0];const done=image=>{if(editId){Object.assign(menu.find(x=>x.id===editId),{name,category,price,image:image||menu.find(x=>x.id===editId).image})}else menu.push({id:crypto.randomUUID(),name,category,price,image:image||'',active:true});persist();editId=null;['menuName','menuCategory','menuPrice'].forEach(id=>$(id).value='');$('menuImage').value='';render()};if(file){const r=new FileReader();r.onload=()=>done(r.result);r.readAsDataURL(file)}else done('')}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
setInterval(renderCash,1000);$('restaurantSearch').oninput=render;$('restaurantNetwork').textContent=navigator.onLine?'متصل':'أوف لاين';persist();render();showHeld();renderCash();
window.RestaurantPOS={hold,checkout,clear,toggleAdmin,saveItem,openCashier,addExpense,printStatement};
})();