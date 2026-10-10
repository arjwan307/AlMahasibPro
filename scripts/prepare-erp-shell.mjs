import fs from 'node:fs';
import path from 'node:path';
const publicDir=new URL('../public/',import.meta.url),files=[];
function walk(dir,prefix=''){for(const row of fs.readdirSync(dir,{withFileTypes:true})){const relative=prefix+row.name;if(row.isDirectory())walk(path.join(dir,row.name),relative+'/');else if(/\.(html|js|css|svg|png|ico|woff2?|webmanifest)$/.test(row.name)&&!['erp-shell-manifest.js','market-service-worker.js','erp-service-worker.js'].includes(row.name))files.push('/'+relative);}}
walk(publicDir.pathname.replace(/^\/([A-Za-z]:)/,'$1'));
fs.writeFileSync(new URL('../public/erp-shell-manifest.js',import.meta.url),'self.ERP_SHELL='+JSON.stringify(files.sort())+';\n');
console.log('ERP shell assets:',files.length);
