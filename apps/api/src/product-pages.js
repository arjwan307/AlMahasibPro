// Keep the two products' page surfaces separate while sharing the accounting engine.
const companyFiles = new Set(['sales-workspace.js','sales-workspace.css','enterprise.html','enterprise.js','enterprise.css','representative.html','representative-ui.js','offline-sync.js','customers.html','customers-ui.js','wholesale-sales.html','wholesale-invoice.html','wholesale-invoice.js','wholesale-invoice.css','assistant.js','assistant.css','developer.html','register.html','password-visibility.js']);
const retailFiles = new Set(['retail.html','retail-login.html','retail-login.js','retail-scope.js','enterprise.css','pos.html','pos-ui.js','offline-sync.js','restaurant-pos.js','restaurant-warehouse.js','market-cashier.html','market-admin.html','market-offline.js','market-cashier-ledger.js','scanner-qrcode.js','market-scanner.html','market-trial-catalog.json','market-service-worker.js','register.html','password-visibility.js']);
export function productPages(product = 'company') {
 if(product==='company'||product==='unified'){companyFiles.add('company-output.js');companyFiles.add('company-output.css');companyFiles.add('company-messages.js');companyFiles.add('company-responsive.css');companyFiles.add('company-responsive.js');companyFiles.add('company-sync-ui.js');}
 retailFiles.add('company-responsive.css');
 for(const set of [companyFiles,retailFiles]){for(const file of ['login.html','login.js','erp-offline.js','erp-service-worker.js','erp-shell-manifest.js','data-import.html','data-import.js'])set.add(file);set.add('safety-center.html');set.add('safety-center.js');set.add('app-ui.css');set.add('app-ui.js');}
 const files = product === 'unified' ? new Set([...companyFiles,...retailFiles]) : product === 'retail' ? retailFiles : companyFiles;
 const login = product === 'retail' ? '/retail-login.html' : '/enterprise.html';
 const home = product === 'retail' ? '/retail.html' : login;
 return (req, res, next) => {
  if(product==='company'&&req.path==='/market-service-worker.js'){res.set('Cache-Control','no-store');return res.type('js').send("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('almahasib-market-shell-'))await caches.delete(key);await self.clients.claim();await self.registration.unregister();})()));");}
  if (req.path.startsWith('/api/')) return next();
  if (['/', '/index.html'].includes(req.path)) { if (product === 'company'||product==='unified') return next(); return res.redirect(login); }
  if (req.path === '/dashboard.html') return res.redirect(home);
  const name = req.path.slice(1);
  if (files.has(name) || files.has(name + '.html')) return next();
  return res.status(404).send('الصفحة غير متاحة في هذا التطبيق');
 };
}

