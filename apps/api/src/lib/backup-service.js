import {mkdir,writeFile,rename,readdir,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

export function startBackupService({store,directory,intervalMs=24*60*60*1000,retain=7,onError=console.error}){
 const root=resolve(directory);let running=null,closed=false;
 const state={directory:root,retain,intervalMs,lastSuccess:null,lastError:null};
 async function run(){if(closed)return false;if(running)return running;
  running=(async()=>{
   if(!store.companies.size)return false;
   await mkdir(root,{recursive:true});const stamp=new Date().toISOString().replace(/[:.]/g,'-'),name='AlMahasibPro-auto-'+stamp+'-'+randomUUID()+'.sqlite',file=join(root,name),temporary=file+'.tmp';
   try{
    const bytes=await store.exportBackup();await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
    const check=new DatabaseSync(temporary,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('النسخة الاحتياطية غير سليمة');}finally{check.close();}
    await rename(temporary,file);
    const names=(await readdir(root)).filter(x=>/^AlMahasibPro-auto-.*\.sqlite$/.test(x)).sort().reverse();
    for(const stale of names.slice(retain))await unlink(join(root,stale));
    state.lastSuccess=new Date().toISOString();state.lastError=null;return file;
   }catch(error){await unlink(temporary).catch(()=>{});state.lastError=String(error.message);onError(error);throw error;}
  })().finally(()=>{running=null;});return running;
 }
 const timer=setInterval(()=>{void run().catch(()=>{});},intervalMs);timer.unref?.();
 return {run,status:()=>({...state}),close:async()=>{closed=true;clearInterval(timer);await running?.catch(()=>{});}};
}
