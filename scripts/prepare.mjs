import {execFileSync} from 'node:child_process';
import {readFile,mkdir,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const root=fileURLToPath(new URL('../',import.meta.url));
export async function prepare(){const lock=JSON.parse(await readFile(path.join(root,'gamestats.lock.json'),'utf8'));const dest=path.join(root,'.deps/gamestats');let exists=false;try{await access(path.join(dest,'.git'));exists=true;}catch{}const run=args=>execFileSync('git',args,{cwd:root,stdio:'inherit',windowsHide:true});if(!exists){await mkdir(path.dirname(dest),{recursive:true});run(['clone','--no-checkout',lock.repository,dest]);}else{const status=execFileSync('git',['-C',dest,'status','--porcelain'],{encoding:'utf8'});if(status.trim())throw new Error('La dependencia .deps/gamestats contiene cambios. Consérvalos antes de actualizarla.');run(['-C',dest,'fetch','origin']);}run(['-C',dest,'checkout','--detach',lock.ref]);console.log('Dependencia GameStats preparada.');return dest;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare();
