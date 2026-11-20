import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { archive } from '../server/sdk/importer/archive.mjs';
const output = path.resolve(process.argv[2] || 'evidence/import-demo.game.zip');
await mkdir(path.dirname(output), { recursive: true });
await archive('pack', fileURLToPath(new URL('../test/fixtures/import-demo/', import.meta.url)), output);
console.log('ZIP preparado: ' + output);
