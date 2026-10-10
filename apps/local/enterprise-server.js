import { startBackupService } from '../api/src/lib/backup-service.js';
import { resetInstallationOnce } from '../api/src/lib/clean-install.js';
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
import { createServer as createHttpsServer } from 'node:https';

export async function startEnterpriseLocal({ dataDirectory, port = 3211, product = 'company', protect, unprotect, allowTestCloud = false, cloudOrigin, resetGeneration, bindHost='127.0.0.1', lanHost, tlsKey, tlsCert,clientOrigins=[] }) {
  if(bindHost!=='127.0.0.1'&&(!lanHost||!tlsKey||!tlsCert))throw new Error('مشاركة خادم الفرع تحتاج اسم شبكة وشهادة HTTPS ومفتاحها');
  if(lanHost&&!/^[A-Za-z0-9.-]+$/.test(lanHost))throw new Error('اسم خادم الشبكة غير صالح');
  const tls=tlsKey&&tlsCert?{key:await readFile(tlsKey),cert:await readFile(tlsCert)}:null,protocol=tls?'https':'http';
  await mkdir(dataDirectory, { recursive: true });
  const store = new SQLiteStore(join(dataDirectory, 'enterprise.sqlite'));
  const cleanInstallation=await resetInstallationOnce(store,dataDirectory,resetGeneration);
  const backups=startBackupService({store,directory:process.env.ALMAHASIB_BACKUP_DIR||join(dataDirectory,'backups')});
  store.backupService=backups;
  const app = express();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if(lanHost)hosts.add(`${lanHost}:${port}`);
  const origins=[...hosts].map(host=>`${protocol}://${host}`);
  if(clientOrigins.length&&!tls)throw new Error('ربط الويب بالشبكة المحلية يحتاج HTTPS');
  for(const origin of clientOrigins){const parsed=new URL(origin);if(parsed.protocol!=='https:'||parsed.origin!==origin)throw new Error('عنوان تطبيق الويب يجب أن يكون أصل HTTPS');origins.push(origin);}
  app.use((req, res, next) => {
    if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) return res.status(403).json({ error: { message: 'المصدر غير مسموح' } });
    next();
  });
  app.use(express.json({ limit: '5mb' }));
  // Shared cloud retail clients use /retail/api; the same local engine serves both interfaces.
  if(product==='unified')app.use((req,_res,next)=>{if(req.path.startsWith('/retail/api/')){req.url=req.url.slice(7);req.originalUrl=req.originalUrl.slice(7);}next();});
  app.get('/desktop-cloud.html',(req,res)=>res.sendFile(fileURLToPath(new URL('../../public/desktop-cloud.html',import.meta.url))));
  const cloud=await installLocalCloud(app,{store,dataDirectory,protect,unprotect,allowTestCloud,cloudOrigin});
  if(product==='unified')app.get(['/', '/index.html'],(_req,res)=>res.redirect('/login.html'));
  app.use(productPages(product));
  if (product === 'retail'||product==='unified') {
    const html = new Set(['/pos.html','/market-cashier.html','/market-admin.html']);
    const scripts = new Set(['/pos-ui.js','/market-offline.js','/market-cashier-ledger.js','/restaurant-pos.js']);
    app.use(async (req, res, next) => {
      if (!html.has(req.path) && !scripts.has(req.path)) return next();
      try {
        const filename = fileURLToPath(new URL('../../public' + req.path, import.meta.url));
        let content = await readFile(filename, 'utf8');
        if (html.has(req.path)) content = content.replace('<head>', '<head><script>window.AlMahasibLocalMode=true;</script>');
        else content = content.replaceAll('navigator.onLine', '(window.AlMahasibLocalMode || navigator.onLine)');
        res.type(html.has(req.path) ? 'html' : 'js').send(content);
      } catch (error) { next(error); }
    });
  }

  app.get('/api/local/status', (req, res) => res.json({ local: true, initialized: store.companies.size > 0, companyCode: [...store.companies.values()][0]?.code,generation:store.installationGeneration||null,lanUrl:lanHost?`${protocol}://${lanHost}:${port}`:null }));
  let configuring = false;
  app.post('/api/local/setup', async (req, res) => {
    if(product==='unified')return res.status(409).json({error:{message:'أدخل رمز الشركة المعتمد واسم المستخدم وكلمة المرور؛ إنشاء الحساب يتم عبر المطور.'}});
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
  app.use(createApp({ store, allowedOrigins: origins,secureCookies:Boolean(tls) }));
  const server = await new Promise((resolve, reject) => { const server = tls?createHttpsServer(tls,app):app;const listening=server.listen(port,bindHost,()=>resolve(listening));listening.on('error',reject); });
  return { url: `${protocol}://127.0.0.1:${port}`, lanUrl:lanHost?`${protocol}://${lanHost}:${port}`:null, cleanInstallation, store, close: async () => { cloud?.close(); await backups.close(); await new Promise(resolve => server.close(resolve)); await store.close(); } };
}
if (process.argv[1]?.endsWith('enterprise-server.js')) {
  const { homedir } = await import('node:os');
  const runtime = await startEnterpriseLocal({ dataDirectory: process.env.ALMAHASIB_DATA_DIR || join(homedir(), 'AlMahasibProData'),port:Number(process.env.ALMAHASIB_PORT||3211),bindHost:process.env.ALMAHASIB_BIND_HOST||'127.0.0.1',lanHost:process.env.ALMAHASIB_LAN_HOST,tlsKey:process.env.ALMAHASIB_TLS_KEY,tlsCert:process.env.ALMAHASIB_TLS_CERT,clientOrigins:(process.env.ALMAHASIB_WEB_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean) });
  console.log(runtime.url + '/enterprise.html');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => runtime.close().then(() => process.exit(0)));
}

