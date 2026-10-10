(() => {
 'use strict';
 const labels=new Set(['الفرع','المخزن','التصنيف','القسم','النوع','الحالة','الدور','الوحدة الأساسية','الكاشير','نوع العملية']);
 const text=node=>(node?.textContent||'').replace(/\s+/g,' ').trim();
 let helpId=0;
 const expanded=new Map();
 const background=getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number);if(background&&background[3]!==0&&(background[0]*.2126+background[1]*.7152+background[2]*.0722)<100)document.body.classList.add('ui-dark');
 function help(node){
  if(node.closest('.ui-help')||node.id||node.hasAttribute('role')||node.querySelector('button,input,select,a'))return;
  const value=text(node);if(!value)return;
  const wrap=document.createElement('span');wrap.className='ui-help';
  const button=document.createElement('button');button.type='button';button.className='ui-help-toggle';button.textContent='!';button.setAttribute('aria-label','مساعدة');button.setAttribute('aria-expanded','false');
  const content=document.createElement('span');content.className='ui-help-text';content.id='ui-help-'+(++helpId);content.textContent=value;content.hidden=true;button.setAttribute('aria-controls',content.id);
  const close=()=>{content.hidden=true;button.setAttribute('aria-expanded','false')};
  button.onclick=()=>{content.hidden=!content.hidden;button.setAttribute('aria-expanded',String(!content.hidden))};
  wrap.addEventListener('keydown',e=>{if(e.key==='Escape'){close();button.focus()}});
  wrap.append(button,content);node.replaceWith(wrap);
 }
 function list(table){
  if(table.closest('.ui-list,details,dialog,.print-output,.customer-print-sheet,#lineTable,#documentDetail,#customerStatement')||table.querySelector('#cartBody')||table.closest('form'))return;
  const headers=[...table.querySelectorAll('thead th')].map(text);if(!headers.length)return;
  const parent=table.parentElement;if(!parent)return;
  const container=table.closest('.panel,.card,section')||parent;
  const title=text(container.querySelector('h2,h3'))||(/المادة|الصنف/.test(headers.join(' '))?'قائمة المواد':'قائمة السجلات');
  const details=document.createElement('details');details.className='ui-list';
  const key=location.pathname+'|'+text(document.querySelector('#pageTitle'))+'|'+title+'|'+headers.join('|');details.open=expanded.get(key)||false;details.addEventListener('toggle',()=>expanded.set(key,details.open));
  const summary=document.createElement('summary');const caption=document.createElement('span');caption.textContent=title;
  const count=document.createElement('span');count.className='ui-list-count';summary.append(caption,count);
  const tools=document.createElement('div');tools.className='ui-list-tools';
  const search=document.createElement('input');search.type='search';search.placeholder='بحث في القائمة';search.setAttribute('aria-label','بحث في '+title);tools.append(search);
  const filters=headers.flatMap((label,index)=>labels.has(label)?[{label,index}]:[]);
  const selects=filters.map(({label,index})=>{const select=document.createElement('select');select.setAttribute('aria-label','تصفية حسب '+label);tools.append(select);return {select,index,label}});
  const empty=document.createElement('p');empty.className='ui-list-empty';empty.textContent='لا توجد نتائج تطابق البحث';empty.hidden=true;
  const wrapper=document.createElement('div');wrapper.className='table-wrap';table.before(details);wrapper.append(table);details.append(summary,tools,wrapper,empty);
  const rows=()=>[...table.tBodies].flatMap(body=>[...body.rows]).filter(row=>!row.querySelector('.empty')&&!(row.cells.length===1&&row.cells[0].colSpan>1));
  function options(){for(const {select,index,label} of selects){const previous=select.value;const values=[...new Set(rows().map(row=>text(row.cells[index])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));select.replaceChildren();const all=new Option('عرض الكل — '+label,'');select.append(all);for(const value of values)select.append(new Option(value,value));if(values.includes(previous))select.value=previous;}apply()}
  function apply(){const query=search.value.trim().toLocaleLowerCase('ar');const data=rows();let visible=0;for(const row of data){const match=(!query||text(row).toLocaleLowerCase('ar').includes(query))&&selects.every(({select,index})=>!select.value||text(row.cells[index])===select.value);row.toggleAttribute('data-ui-filtered',!match);if(match)visible++;}count.textContent=visible+' / '+data.length+' سجل';empty.hidden=!data.length||visible>0;}
  search.addEventListener('input',apply);for(const {select} of selects)select.addEventListener('change',apply);
  new MutationObserver(options).observe(table,{childList:true,subtree:true,characterData:true});options();
 }
 function supplierList(container){
  if(container.closest('.ui-list'))return;
  const details=document.createElement('details');details.className='ui-list';
  const summary=document.createElement('summary');summary.textContent='دليل الموردين';
  const tools=document.createElement('div');tools.className='ui-list-tools';
  const search=document.createElement('input');search.type='search';search.placeholder='بحث عن مورد';search.setAttribute('aria-label','بحث عن مورد');
  const select=document.createElement('select');select.setAttribute('aria-label','تصفية الموردين حسب الدولة');select.append(new Option('عرض الكل — الدولة',''));
  const cards=[...container.querySelectorAll('.supplier-card')];for(const country of [...new Set(cards.map(x=>x.dataset.country).filter(Boolean))].sort())select.append(new Option(country,country));
  const count=document.createElement('span');count.className='ui-list-count';summary.append(count);
  const apply=()=>{let visible=0;for(const card of cards){const match=text(card).toLowerCase().includes(search.value.trim().toLowerCase())&&(!select.value||card.dataset.country===select.value);card.toggleAttribute('data-ui-filtered',!match);if(match)visible++;}count.textContent=visible+' / '+cards.length+' مورد'};
  search.oninput=select.onchange=apply;tools.append(search,select);container.before(details);details.append(summary,tools,container);apply();
 }
 function decorate(){
  document.querySelectorAll('.main-icon-card[onclick]:not([role]),.sub-icon-card[onclick]:not(a):not([role])').forEach(card=>{card.setAttribute('role','button');card.tabIndex=0;card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();card.click()}})});
  document.querySelectorAll('.supplier-list').forEach(supplierList);
  document.querySelectorAll('table').forEach(list);
  document.querySelectorAll('p[data-ui-help],p.muted:not([id])').forEach(node=>{
   if(node.hasAttribute('data-ui-help')||/سعر الصرف هو|عرّف الوحدات|امسح المادة بالهاتف|يبقى النقد|يبقى رصيد|عند تسجيل تسليم|يمكنك |لإضافة |اختر .*ثم|اربط .*مندوب|أنشئ مستخدمًا|إخراج مخزني مستقل|الفاتورة تخصم المخزون/.test(text(node)))help(node);
  });
 }
 let queued=false;const observer=new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;decorate()})});
 observer.observe(document.body,{childList:true,subtree:true});decorate();
})();
