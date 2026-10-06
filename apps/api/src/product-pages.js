// Keep the two products' page surfaces separate while sharing the accounting engine.
const companyFiles = new Set(['enterprise.html','enterprise.js','enterprise.css','representative.html','representative-ui.js','offline-sync.js']);
const retailFiles = new Set(['retail.html','retail-login.html','retail-login.js','retail-scope.js','enterprise.css','pos.html','pos-ui.js','offline-sync.js','restaurant-pos.js','restaurant-warehouse.js','market-cashier.html','market-admin.html','market-offline.js','market-cashier-ledger.js','scanner-qrcode.js','market-scanner.html','market-trial-catalog.json','market-service-worker.js']);
export function productPages(product = 'company') {
 const files = product === 'retail' ? retailFiles : companyFiles;
 const login = product === 'retail' ? '/retail-login.html' : '/enterprise.html';
 const home = product === 'retail' ? '/retail.html' : login;
 return (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (['/', '/index.html'].includes(req.path)) return res.redirect(login);
  if (req.path === '/dashboard.html') return res.redirect(home);
  const name = req.path.slice(1);
  if (files.has(name) || files.has(name + '.html')) return next();
  return res.status(404).send('الصفحة غير متاحة في هذا التطبيق');
 };
}
