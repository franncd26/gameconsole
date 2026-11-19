import {spawnSync} from 'node:child_process';
import {cp,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {root,prepare} from './prepare.mjs';
const stop=process.argv.includes('--stop');
let cwd=root;
if(!stop){const source=await prepare();if(process.platform==='win32'&&/[^\x00-\x7F]/.test(root)){cwd=path.join(os.tmpdir(),'gameconsole-'+createHash('sha256').update(root).digest('hex').slice(0,10));await mkdir(cwd,{recursive:true});const exclude=new Set(['.git','.deps','node_modules','evidence','.cache','.tools','target']);const filter=p=>!exclude.has(path.basename(p));await cp(root,cwd,{recursive:true,filter});await mkdir(path.join(cwd,'.deps'),{recursive:true});await cp(source,path.join(cwd,'.deps/gamestats'),{recursive:true,filter});console.log('Se utiliza una copia de construcción sin tildes: '+cwd);}}
const args=['compose','-p','gameconsole',...(stop?['down']:['up','-d','--build','--wait'])];const result=spawnSync('docker',args,{cwd,stdio:'inherit',windowsHide:true,env:{...process.env,GAMESTATS_SOURCE:path.join(cwd,'.deps/gamestats')}});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);if(!stop)console.log('GameConsole disponible en http://127.0.0.1:'+(process.env.PORT||3000));
