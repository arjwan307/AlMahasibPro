import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(dir,x.name)):/\.test\.(js|cjs)$/.test(x.name)?[join(dir,x.name)]:[]);
const run=spawnSync(process.execPath,['--test',...walk('tests')],{stdio:'inherit'});process.exit(run.status??1);
