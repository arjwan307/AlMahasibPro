(() => {
 'use strict';
 const aside=document.querySelector('#workspace>aside'),nav=aside?.querySelector('nav');if(!aside||!nav)return;
 nav.id=nav.id||'companyNavigation';
 const button=document.createElement('button');button.type='button';button.className='mobile-menu-toggle';button.textContent='☰ الأقسام';button.setAttribute('aria-controls',nav.id);button.setAttribute('aria-expanded','false');aside.prepend(button);
 const close=()=>{nav.classList.remove('mobile-open');aside.classList.remove('mobile-open');button.setAttribute('aria-expanded','false');};
 button.onclick=()=>{const open=button.getAttribute('aria-expanded')!=='true';nav.classList.toggle('mobile-open',open);aside.classList.toggle('mobile-open',open);button.setAttribute('aria-expanded',String(open));};
 nav.addEventListener('click',event=>{if(event.target.closest('button[data-view]'))close();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&button.getAttribute('aria-expanded')==='true'){close();button.focus();}});
 window.matchMedia('(max-width:1024px)').addEventListener('change',close);
})();
