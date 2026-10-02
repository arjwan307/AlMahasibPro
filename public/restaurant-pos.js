(function(){'use strict';
if(new URLSearchParams(location.search).get('mode')!=='restaurant')return;
document.getElementById('restaurantExperience').classList.add('active');document.getElementById('legacyPos').classList.add('hidden-pos');
const seed=[
['كباب عراقي','مشويات',12000,'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?auto=format&fit=crop&w=500&q=80'],
['قوزي','أكلات شرقية',15000,'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=500&q=80'],
['برغر لحم','وجبات سريعة',9000,'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=500&q=80'],
['بيتزا','وجبات سريعة',10000,'https://images.unsplash.com/photo-1579751626657-72bc17010498?auto=format&fit=crop&w=500&q=80'],
['شاي عراقي','مشروبات ساخنة',1500,'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=500&q=80'],
['كابتشينو','مشروبات ساخنة',4000,'https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&w=500&q=80'],
['عصير برتقال طبيعي','عصائر طبيعية',5000,'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=500&q=80'],
['موهيتو','مشروبات باردة',5000,'https://images.unsplash.com/photo-1551538827-9c037cb4f32a?auto=format&fit=crop&w=500&q=80'],
['آيس كريم','آيس كريم',4000,'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=500&q=80'],
['أركيلة تفاحتين','أركيلة',10000,'https://images.unsplash.com/photo-1525268323446-0505b6fe7778?auto=format&fit=crop&w=500&q=80']
];
let menu=JSON.parse(localStorage.getItem('hawa_dijla_menu')||'null')||seed.map((x,i)=>({id:'demo-'+i,name:x[0],category:x[1],price:x[2],image:x[3],active:true}));
let cart=[],cat='الكل',editId=null; const $=id=>document.getElementById(id);
function persist(){localStorage.setItem('hawa_dijla_menu',JSON.stringify(menu))}
function render(){const cats=['الكل',...new Set(menu.map(x=>x.category))];$('categoryTabs').innerHTML=cats.map(x=>'<button class="btn '+(x===cat?'btn-primary':'')+'" data-cat="'+esc(x)+'">'+esc(x)+'</button>').join('');document.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{cat=b.dataset.cat;render()});const q=$('restaurantSearch').value.trim();$('productGrid').innerHTML=menu.filter(x=>x.active&&(cat==='الكل'||x.category===cat)&&(!q||x.name.includes(q))).map(x=>'<article class="product" data-id="'+x.id+'"><img src="'+esc(x.image)+'" alt=""><div class="info"><b>'+esc(x.name)+'</b><div class="price">'+Number(x.price).toLocaleString('ar-IQ')+' د.ع</div></div></article>').join('');document.querySelectorAll('.product').forEach(p=>p.onclick=()=>add(p.dataset.id));renderCart()}
function add(id){const item=menu.find(x=>x.id===id),line=cart.find(x=>x.id===id);if(line)line.qty++;else cart.push({...item,qty:1});renderCart()}
function renderCart(){$('restaurantCart').innerHTML=cart.length?cart.map(x=>'<div class="order-line"><div><b>'+esc(x.name)+'</b><br><small>'+Number(x.price*x.qty).toLocaleString('ar-IQ')+' د.ع</small></div><div class="qty"><button data-minus="'+x.id+'">−</button><b>'+x.qty+'</b><button data-plus="'+x.id+'">+</button></div></div>').join(''):'<p style="color:#64748b">اضغط على صورة أي صنف لإضافته.</p>';$('restaurantTotal').textContent=cart.reduce((s,x)=>s+x.price*x.qty,0).toLocaleString('ar-IQ');document.querySelectorAll('[data-plus]').forEach(b=>b.onclick=()=>{cart.find(x=>x.id===b.dataset.plus).qty++;renderCart()});document.querySelectorAll('[data-minus]').forEach(b=>b.onclick=()=>{const x=cart.find(x=>x.id===b.dataset.minus);x.qty--;if(x.qty<=0)cart=cart.filter(y=>y.id!==x.id);renderCart()})}
function hold(){if(!cart.length)return alert('الطلب فارغ');const ref=$('orderReference').value.trim()||'طلب '+Date.now();const orders=JSON.parse(localStorage.getItem('hawa_dijla_orders')||'[]');orders.push({id:crypto.randomUUID(),ref,cart,total:cart.reduce((s,x)=>s+x.price*x.qty,0),status:'open',at:new Date().toISOString()});localStorage.setItem('hawa_dijla_orders',JSON.stringify(orders));cart=[];renderCart();showHeld()}
function showHeld(){const o=JSON.parse(localStorage.getItem('hawa_dijla_orders')||'[]').filter(x=>x.status==='open');$('heldOrders').innerHTML=o.length?'<b>طلبات مفتوحة</b>'+o.map(x=>'<button class="btn" style="width:100%;margin-top:6px" data-order="'+x.id+'">'+esc(x.ref)+' · '+Number(x.total).toLocaleString('ar-IQ')+'</button>').join(''):'';document.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>{const x=o.find(y=>y.id===b.dataset.order);cart=structuredClone(x.cart);$('orderReference').value=x.ref;renderCart()})}
function checkout(){if(!cart.length)return alert('الطلب فارغ');alert('الإجمالي '+cart.reduce((s,x)=>s+x.price*x.qty,0).toLocaleString('ar-IQ')+' د.ع — الخطوة التالية ربط الدفع والفاتورة بالخادم.')}
function clear(){cart=[];$('orderReference').value='';renderCart()}
function toggleAdmin(){$('menuAdmin').classList.toggle('hidden-pos')}
function saveItem(){const name=$('menuName').value.trim(),category=$('menuCategory').value.trim(),price=Number($('menuPrice').value);if(!name||!category||!price)return alert('أكمل الاسم والقسم والسعر');const file=$('menuImage').files[0];const done=image=>{if(editId){Object.assign(menu.find(x=>x.id===editId),{name,category,price,image:image||menu.find(x=>x.id===editId).image})}else menu.push({id:crypto.randomUUID(),name,category,price,image:image||'',active:true});persist();editId=null;['menuName','menuCategory','menuPrice'].forEach(id=>$(id).value='');$('menuImage').value='';render()};if(file){const r=new FileReader();r.onload=()=>done(r.result);r.readAsDataURL(file)}else done('')}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
$('restaurantSearch').oninput=render;$('restaurantNetwork').textContent=navigator.onLine?'متصل':'أوف لاين';persist();render();showHeld();
window.RestaurantPOS={hold,checkout,clear,toggleAdmin,saveItem};
})();