const { app, BrowserWindow, dialog, Menu } = require('electron');
const path = require('node:path');
let runtime, closing = false;
app.setName('AlMahasibProRetail');
app.setPath('userData', path.join(app.getPath('appData'), 'AlMahasibProRetail'));
app.whenReady().then(async () => {
 try {
  const { startEnterpriseLocal } = await import('../local/enterprise-server.js');
  runtime = await startEnterpriseLocal({ dataDirectory: app.getPath('userData'), port: 3212, product: 'retail' });
  const window = new BrowserWindow({ width: 1440, height: 950, minWidth: 960, minHeight: 640, title: 'المحاسب برو — المطاعم والمجمعات', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(runtime.url + '/')) event.preventDefault(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'الملف', submenu: [{ role: 'quit', label: 'خروج' }] }, { label: 'عرض', submenu: [{ role: 'reload', label: 'تحديث' }, { role: 'togglefullscreen', label: 'ملء الشاشة' }] }]));
  await window.loadURL(runtime.url + '/retail-login.html');
 } catch (error) { dialog.showErrorBox('تعذر تشغيل المحاسب برو للمطاعم والمجمعات', error.message); app.quit(); }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (runtime && !closing) { event.preventDefault(); closing = true; runtime.close().finally(() => app.quit()); } });
