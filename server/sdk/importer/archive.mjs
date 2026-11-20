import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
export async function archive(command, source, destination) {
  const executable = process.platform === 'win32' ? 'py' : 'python3';
  const args = [...(process.platform === 'win32' ? ['-3'] : []), '-I', fileURLToPath(new URL('./archive.py', import.meta.url)), command, source, destination];
  try { const r = await run(executable, args, { timeout: 30000, maxBuffer: 4096, windowsHide: true }); return r.stdout ? JSON.parse(r.stdout) : undefined; }
  catch { const e = new Error('ZIP inválido o herramienta Python 3 no disponible.'); e.code = 'INVALID_ARCHIVE'; throw e; }
}
