function installDesktopInputFocus({window,ipcMain,dialog,origin}) {
 const trusted=event=>event.sender===window.webContents&&(()=>{try{return new URL(event.senderFrame?.url||'').origin===origin;}catch{return false;}})();
 const restore=()=>{if(window.isDestroyed()||!window.isVisible())return;window.focus();window.webContents.focus();};
 const focus=event=>{if(trusted(event))restore();};
 const message=(event,kind,text)=>{
  event.returnValue=false;if(!trusted(event)||!['confirm','alert'].includes(kind)||typeof text!=='string'||text.length>8000)return;
  try{const answer=dialog.showMessageBoxSync(window,{type:kind==='confirm'?'question':'info',message:text,buttons:kind==='confirm'?['إلغاء','موافق']:['موافق'],defaultId:0,cancelId:0,noLink:true});event.returnValue=kind==='confirm'&&answer===1;}finally{restore();}
 };
 ipcMain.on('company-input-focus',focus);ipcMain.on('company-message-dialog',message);
 window.on('focus',()=>{if(!window.webContents.isDestroyed())window.webContents.focus();});
 window.on('closed',()=>{ipcMain.removeListener('company-input-focus',focus);ipcMain.removeListener('company-message-dialog',message);});
 return restore;
}
module.exports={installDesktopInputFocus};
