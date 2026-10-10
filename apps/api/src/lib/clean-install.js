// Explicit maintenance operation. Never run implicitly on an ordinary upgrade.
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';

export async function resetInstallationOnce(store, directory, token) {
 const root=resolve(directory), marker=join(root,'clean-install-generation.json');
 let previous;
 try {previous=JSON.parse(await readFile(marker,'utf8')).generation;store.installationGeneration=previous;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!token||previous===token)return false;
 if(!/^[A-Za-z0-9_-]{12,100}$/.test(token))throw Error('Invalid reset generation');
 await clearCompanyData(store);
 for(const entry of await readdir(root,{withFileTypes:true})) {
  if(!['backups','item-photos','retail','cloud-connection.json','cloud-connection.json.tmp'].includes(entry.name)&&!/^before-(cloud|restore).*\.sqlite$/.test(entry.name))continue;
  const target=resolve(root,entry.name),child=relative(root,target);
  if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Reset path outside data directory');
  await rm(target,{recursive:entry.isDirectory(),force:true});
 }
 await writeFile(marker,JSON.stringify({generation:token,completedAt:new Date().toISOString()}));
 store.installationGeneration=token;
 return true;
}

export async function clearCompanyData(store) {
  const administrators = new Map([...store.users].filter(([, user]) => user.platformAdmin === true));
  if (store.sqlite) store.sqlite.exec('PRAGMA secure_delete=ON;');
  await store.transaction(() => {
    for (const key of Object.keys(store)) {
      if (store[key] instanceof Map) store[key].clear();
      else if (Array.isArray(store[key])) store[key].length = 0;
    }
    store.users = administrators;
    store.changeSequence = 0;
  });
  if (store.sqlite) {
    store.sqlite.exec('PRAGMA secure_delete=ON; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  return { companies: store.companies.size, users: store.users.size, administrators: administrators.size };
}
