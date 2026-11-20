import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function syntaxFiles(directory = root) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (['node_modules', '.git', '.deps', '.cache', 'evidence'].includes(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(file);
    }
  }
  for (const name of ['server', 'public', 'plugins', 'scripts', 'test']) await visit(path.join(directory, name));
  return files.sort();
}
export async function checkSyntax() {
  const files = await syntaxFiles();
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) return result.status || 1;
  }
  console.log(`Sintaxis aprobada: ${files.length} archivos; sin ejecutar módulos, juegos o servicios.`);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await checkSyntax();
