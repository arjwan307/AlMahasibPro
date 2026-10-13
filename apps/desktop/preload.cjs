const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('AlMahasibDesktop',{
 focusEditor:()=>ipcRenderer.send('company-input-focus'),
 confirm:text=>ipcRenderer.sendSync('company-message-dialog','confirm',String(text)),
 alert:text=>ipcRenderer.sendSync('company-message-dialog','alert',String(text))
});
