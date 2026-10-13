const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {installDesktopInputFocus}=require('../../apps/desktop/input-focus.cjs');
test('desktop dialogs are parented, keep cancel as default, and restore editor focus without exposing IPC to other windows',()=>{
 const ipcMain=new EventEmitter(),window=new EventEmitter();let windowFocus=0,editorFocus=0,dialogs=0;
 window.focus=()=>windowFocus++;window.isDestroyed=()=>false;window.isVisible=()=>true;window.webContents={focus:()=>editorFocus++,isDestroyed:()=>false};
 const dialog={showMessageBoxSync:(parent,options)=>{assert.equal(parent,window);assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);dialogs++;return 1;}};
 installDesktopInputFocus({window,ipcMain,dialog,origin:'http://127.0.0.1:3213'});
 const trusted={sender:window.webContents,senderFrame:{url:'http://127.0.0.1:3213/enterprise.html'}};
 ipcMain.emit('company-input-focus',trusted);assert.equal(editorFocus,1);
 ipcMain.emit('company-message-dialog',trusted,'confirm','هل تريد المتابعة؟');assert.equal(trusted.returnValue,true);assert.equal(editorFocus,2);assert.equal(windowFocus,2);
 for(const event of [{sender:{},senderFrame:trusted.senderFrame},{sender:window.webContents,senderFrame:{url:'https://other.example/'} }]){ipcMain.emit('company-message-dialog',event,'confirm','ignored');assert.equal(event.returnValue,false);ipcMain.emit('company-input-focus',event);}
 assert.equal(dialogs,1);assert.equal(editorFocus,2);window.emit('closed');assert.equal(ipcMain.listenerCount('company-input-focus'),0);assert.equal(ipcMain.listenerCount('company-message-dialog'),0);
});

const {refreshCompanyShell}=require('../../apps/desktop/company-runtime.cjs');
test('desktop shell refresh clears only interface caches and retains cookies and financial outbox storage',async()=>{let storages,cleared=false;await refreshCompanyShell({clearCache:async()=>{cleared=true;},clearStorageData:async options=>{storages=options.storages;}});assert.equal(cleared,true);assert.deepEqual(storages,['serviceworkers','cachestorage']);assert.equal(storages.includes('indexdb'),false);assert.equal(storages.includes('cookies'),false);});
