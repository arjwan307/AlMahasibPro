const { app, BrowserWindow, dialog, Menu, net, shell, safeStorage } = require('electron');
const path = require('node:path');
// Preserve existing company data when installing the independently named product.
app.setPath('userData', process.env.ALMAHASIB_DATA_DIR ? path.resolve(process.env.ALMAHASIB_DATA_DIR) : path.join(app.getPath('appData'), 'AlMahasibPro'));
let runtime;
app.on('second-instance',()=>{const current=BrowserWindow.getAllWindows()[0];if(current){if(current.isMinimized())current.restore();current.show();current.focus();}});
if(!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(async () => {
  try {
    const { startEnterpriseLocal } = await import('../local/enterprise-server.js');
    runtime = await startEnterpriseLocal({ dataDirectory: app.getPath('userData'), port: Number(process.env.ALMAHASIB_PORT || 3211), product: 'unified', resetGeneration:'clean_20261010_125', bindHost:process.env.ALMAHASIB_BIND_HOST||'127.0.0.1',lanHost:process.env.ALMAHASIB_LAN_HOST,tlsKey:process.env.ALMAHASIB_TLS_KEY,tlsCert:process.env.ALMAHASIB_TLS_CERT, protect: bytes => { if(!safeStorage.isEncryptionAvailable()) throw Error('تعذر حماية جلسة السحابة على الجهاز'); return safeStorage.encryptString(bytes.toString()); }, unprotect: bytes => Buffer.from(safeStorage.decryptString(bytes)) });
    const window = new BrowserWindow({ show: process.env.ALMAHASIB_SMOKE_TEST !== '1', width: 1440, height: 950, minWidth: 960, minHeight: 640, title: 'المحاسب برو', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    if(runtime.cleanInstallation)await window.webContents.session.clearStorageData();
    window.webContents.setWindowOpenHandler(({url}) => {
      try{const target=new URL(url);if(target.protocol==='https:'&&target.hostname==='wa.me'&&/^\/\d{8,15}$/.test(target.pathname))shell.openExternal(target.href).catch(()=>dialog.showErrorBox('واتساب','تعذر فتح واتساب على هذا الجهاز'));}catch{}
      return {action:'deny'};
    });
    window.webContents.on('will-navigate', (event, url) => {
      if(url===runtime.url+'/developer.html'){
        event.preventDefault();
        const origin='https://shenoo-menoo-tak-tak.onrender.com';
        const developer=new BrowserWindow({parent:window,width:1100,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
        developer.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        developer.webContents.on('will-navigate',(navigation,target)=>{try{if(new URL(target).origin!==origin)navigation.preventDefault();}catch{navigation.preventDefault();}});
        void developer.loadURL(origin+'/developer.html').catch(error=>dialog.showErrorBox('لوحة المطور',error.message));
      }else if(!url.startsWith(runtime.url+'/'))event.preventDefault();
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'الملف', submenu: [{ label: 'ربط الشركة بالسحابة', click: () => window.loadURL(runtime.url+'/desktop-cloud.html') }, { label: 'أخذ نسخة احتياطية', click: createBackup }, { label: 'استعادة نسخة احتياطية', click: restoreBackup }, { role: 'quit', label: 'خروج' }] }, { label: 'عرض', submenu: [{ role: 'reload', label: 'تحديث' }, { role: 'togglefullscreen', label: 'ملء الشاشة' }] }]));
    await window.loadURL(runtime.url + '/index.html');
  } catch (error) { dialog.showErrorBox('تعذر تشغيل المحاسب برو', error.message); app.quit(); }
});
app.on('window-all-closed', () => app.quit());
let closing = false;
app.on('before-quit', event => {
  if (runtime && !closing) { event.preventDefault(); closing = true; runtime.close().finally(() => app.quit()); }
});

async function createBackup(){
 try{
  const response=await net.fetch(runtime.url+'/api/v1/enterprise/backup',{credentials:'include'});
  if(!response.ok){const result=await response.json();throw Error(result.error?.message||'تعذر أخذ النسخة الاحتياطية');}
  const choice=await dialog.showSaveDialog({title:'حفظ نسخة احتياطية',defaultPath:'AlMahasibPro-'+new Date().toISOString().slice(0,10)+'.sqlite',filters:[{name:'SQLite',extensions:['sqlite']}]});
  if(choice.canceled)return;
  const fs=require('node:fs/promises');await fs.writeFile(choice.filePath,Buffer.from(await response.arrayBuffer()));
  await dialog.showMessageBox({type:'info',message:'حُفظت النسخة الاحتياطية بنجاح'});
 }catch(error){dialog.showErrorBox('النسخة الاحتياطية',error.message);}
}
async function restoreBackup() {
 try {
  const response = await net.fetch(runtime.url + '/api/v1/bootstrap', { credentials: 'include' });
  const account = await response.json();
  if (!response.ok || !account.permissions?.includes('company.manage')) throw Error('سجّل الدخول كمدير الشركة لاستعادة نسخة احتياطية');
  const selected = await dialog.showOpenDialog({ title: 'اختيار نسخة المحاسب برو', properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['sqlite'] }] });
  if (selected.canceled) return;
  const { DatabaseSync } = require('node:sqlite');
  const check = new DatabaseSync(selected.filePaths[0], { readOnly: true });
  try {
   if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('ملف النسخة الاحتياطية غير سليم');
   const fields = check.prepare('SELECT field FROM domain_state').all().map(row => row.field);
   if (!['companies','users','commerceDocuments','stockBalances'].every(field => fields.includes(field))) throw Error('ليست نسخة احتياطية للمحاسب برو');
  } finally { check.close(); }
  const confirm = await dialog.showMessageBox({ type: 'warning', buttons: ['إلغاء', 'استعادة'], defaultId: 0, message: 'ستحل النسخة الاحتياطية محل بيانات الجهاز. سيُحفظ ملف احتياطي للبيانات الحالية قبل الاستعادة.' });
  if (confirm.response !== 1) return;
  const fs = require('node:fs/promises');
  const dataPath = app.getPath('userData');
  const backup = await runtime.store.exportBackup();
  await fs.writeFile(path.join(dataPath, 'before-restore-' + Date.now() + '.sqlite'), backup);
  await runtime.close(); runtime = null;
  const destination = path.join(dataPath, 'enterprise.sqlite');
  const temporary = destination + '.restoring';
  await fs.copyFile(selected.filePaths[0], temporary);
  const { SQLiteStore } = await import('../api/src/store/sqlite-store.js');
  const restored = new SQLiteStore(temporary);
  await restored.transaction(()=>restored.sessions.clear());
  await restored.close();
  await fs.rename(temporary, destination);
  app.relaunch(); app.exit(0);
 } catch (error) { dialog.showErrorBox('تعذر الاستعادة', error.message); }
}


