import { installLocalCloud } from './cloud-sync.js';
import { productPages } from '../api/src/product-pages.js';
import express from 'express';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../api/src/app.js';
import { SQLiteStore } from '../api/src/store/sqlite-store.js';
import { hashPassword } from '../api/src/lib/security.js';
import { normalizeUsername } from '../api/src/lib/http.js';

export async function startEnterpriseLocal({ dataDirectory, port = 3211, product = 'company', protect, unprotect, allowTestCloud = false }) {
  await mkdir(dataDirectory, { recursive: true });
  const store = new SQLiteStore(join(dataDirectory, 'enterprise.sqlite'));
  const app = express();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host) || (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin))) return res.status(403).json({ error: { message: 'المصدر غير مسموح' } });
    next();
  });
  app.use(express.json({ limit: '5mb' }));
  app.get('/desktop-cloud.html',(req,res)=>res.sendFile(fileURLToPath(new URL('../../public/desktop-cloud.html',import.meta.url))));
  const cloud=product==='company'?await installLocalCloud(app,{store,dataDirectory,protect,unprotect,allowTestCloud}):null;
  app.use(productPages(product));
  if (product === 'retail') {
    const html = new Set(['/pos.html','/market-cashier.html','/market-admin.html']);
    const scripts = new Set(['/pos-ui.js','/market-offline.js','/market-cashier-ledger.js','/restaurant-pos.js']);
    app.use(async (req, res, next) => {
      if (!html.has(req.path) && !scripts.has(req.path)) return next();
      try {
        const filename = fileURLToPath(new URL('../../public' + req.path, import.meta.url));
        let content = await readFile(filename, 'utf8');
        if (html.has(req.path)) content = content.replace('<head>', '<head><script>window.AlMahasibLocalMode=true;</script>');
        else content = content.replaceAll('navigator.onLine', '(!window.AlMahasibLocalMode && navigator.onLine)');
        res.type(html.has(req.path) ? 'html' : 'js').send(content);
      } catch (error) { next(error); }
    });
  }

  app.get('/api/local/status', (req, res) => res.json({ local: true, initialized: store.companies.size > 0, companyCode: [...store.companies.values()][0]?.code }));
  let configuring = false;
  app.post('/api/local/setup', async (req, res) => {
    if (store.companies.size || configuring) return res.status(409).json({ error: { message: 'تم إعداد الشركة سابقًا' } });
    configuring = true;
    try {
      const { legalName, ownerName, username, password } = req.body;
      if (!legalName?.trim() || !ownerName?.trim() || !username?.trim() || typeof password !== 'string' || password.length < 10) throw new Error('أكمل البيانات؛ كلمة المرور عشرة أحرف على الأقل');
      const company = await store.registerCompany({ code: 'local', legalName: legalName.trim(), timezone: 'Asia/Baghdad', currency: 'IQD', owner: { username: normalizeUsername(username), displayName: ownerName.trim(), passwordHash: await hashPassword(password) } });
      await store.approveCompany(company.id, company.ownerUserId);
      res.status(201).json({ companyCode: company.code });
    } catch (error) { res.status(400).json({ error: { message: error.message } }); }
    finally { configuring = false; }
  });
  app.use(createApp({ store, allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] }));
  const server = await new Promise((resolve, reject) => { const server = app.listen(port, '127.0.0.1', () => resolve(server)); server.on('error', reject); });
  return { url: `http://127.0.0.1:${port}`, store, close: async () => { cloud?.close(); await new Promise(resolve => server.close(resolve)); await store.close(); } };
}
if (process.argv[1]?.endsWith('enterprise-server.js')) {
  const { homedir } = await import('node:os');
  const runtime = await startEnterpriseLocal({ dataDirectory: process.env.ALMAHASIB_DATA_DIR || join(homedir(), 'AlMahasibProData') });
  console.log(runtime.url + '/enterprise.html');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => runtime.close().then(() => process.exit(0)));
}
