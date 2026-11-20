import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { root, prepare } from './prepare.mjs';

export async function seedProfiles(source, target) {
  await mkdir(target, { recursive: true });
  if (process.platform !== 'win32') await chmod(target, 0o777); // Shared local lab bind, Node 1000 writes; Scala 10001 only reads.
  for (const name of await readdir(source)) if (name.endsWith('.json')) {
    const bytes = await readFile(path.join(source, name));
    try { await writeFile(path.join(target, name), bytes, { flag: 'wx', mode: 0o644 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (!(await readFile(path.join(target, name))).equals(bytes)) throw Error('Un perfil original compartido difiere del SHA fijado; no se sobrescribe.'); }
  }
}
export async function deployImporter(stop = process.argv.includes('--stop')) {
  const data = path.resolve(process.env.GAMECONSOLE_IMPORT_DATA || path.join(root, '.local/importer/data'));
  const profiles = path.resolve(process.env.GAMECONSOLE_IMPORT_PROFILES || path.join(root, '.local/importer/profiles'));
  const control = path.resolve(process.env.GAMECONSOLE_IMPORT_STATE || path.join(root, '.local/importer/control'));
  let cwd = root;
  const run = args => {
    const r = spawnSync('docker', args, { cwd, windowsHide: true, stdio: 'inherit', env: { ...process.env, GAMESTATS_SOURCE: path.join(cwd, '.deps/gamestats'), GAMECONSOLE_IMPORT_DATA: data, GAMECONSOLE_IMPORT_PROFILES: profiles, GAMECONSOLE_IMPORT_STATE: control } });
    if (r.error || r.status !== 0) throw Error('Docker no completó el despliegue experimental.');
  };
  if (!stop) {
    const source = await prepare(); await seedProfiles(path.join(source, 'docs/examples/profiles'), profiles);
    await mkdir(data, { recursive: true }); if (process.platform !== 'win32') await chmod(data, 0o777);
    await mkdir(control, { recursive: true }); if (process.platform !== 'win32') await chmod(control, 0o777);
    if (process.platform === 'win32' && /[^\x00-\x7F]/.test(root)) {
      cwd = path.join(os.tmpdir(), 'gameconsole-importer-' + createHash('sha256').update(root).digest('hex').slice(0, 10));
      const excluded = new Set(['.git','.deps','.local','node_modules','evidence','.cache','.tools','target']);
      const filter = file => !excluded.has(path.basename(file));
      await cp(root, cwd, { recursive: true, filter }); await mkdir(path.join(cwd, '.deps'), { recursive: true });
      await cp(source, path.join(cwd, '.deps/gamestats'), { recursive: true, filter });
    }
    run(['compose', '-f', 'compose.yaml', '-p', 'gameconsole-importer', 'build']); // Locked, unchanged base images; no academic containers touched.
  }
  run(['compose', '-f', 'compose.importer.yaml', '-p', 'gameconsole-importer', ...(stop ? ['down'] : ['up','-d','--build','--wait','--wait-timeout','180'])]);
  if (!stop) console.log('Importador local: http://127.0.0.1:' + (process.env.PORT || 3001));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await deployImporter();
