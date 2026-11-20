import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverPlugins } from '../../server/sdk/registry.mjs';
import { GamePluginLoader } from '../../server/sdk/loader.mjs';
import { GameSessionFactory } from '../../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../../server/sdk/instance-manager.mjs';

/** Test utilities only: copy actual package; optional factory dependency injection in that copy. */
export async function packageHarness(t, id, { entrypoint } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sdk-${id}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'relocated');
  const original = new URL(`../../plugins/${id}/`, import.meta.url);
  await cp(original, dir, { recursive: true });
  let control;
  if (entrypoint) {
    await copyFile(path.join(dir, 'server/index.mjs'), path.join(dir, 'server/original-index.mjs'));
    await writeFile(path.join(dir, 'server/index.mjs'), entrypoint);
  }
  const { registry, errors } = await discoverPlugins(root);
  assert.deepEqual(errors, []);
  const loader = new GamePluginLoader(registry, { trustedIds: [id] });
  const factory = new GameSessionFactory(loader);
  await loader.load(id);
  if (entrypoint) control = (await import(pathToFileURL(await realpath(path.join(dir, 'server/index.mjs'))).href)).control;
  const events = [], batches = [];
  const sink = { before: async () => {},
    async accept(event) { await this.before([event]); events.push(structuredClone(event)); },
    async acceptBatch(batch) { await this.before(batch); batches.push(structuredClone(batch)); events.push(...structuredClone(batch)); },
  };
  const manager = new GameInstanceManager(factory, { eventSink: sink });
  let serial = 0;
  return { root, dir, control, registry, loader, factory, manager, events, batches, sink,
    async start(options) {
      const prepared = await manager.create(id, options === undefined ? {} : { options });
      return manager.activate(prepared.matchId);
    },
    dispatch(matchId, type, payload, extra = {}) {
      return manager.dispatch(matchId, { requestId: `request-${++serial}`, type, payload, ...extra });
    },
  };
}

export async function verifyPackage(id, expectedBlob) {
  const root = new URL(`../../plugins/${id}/`, import.meta.url);
  const profile = await readFile(new URL('analytics/profile.json', root));
  const content = profile.filter((byte, index) => byte !== 13 || profile[index + 1] !== 10);
  assert.equal(createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'), expectedBlob);
  for (const name of await readdir(new URL('server/', root))) {
    const source = await readFile(new URL(`server/${name}`, root), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'));
      const relative = path.relative(fileURLToPath(root), path.resolve(fileURLToPath(new URL('server/', root)), specifier));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }
    assert.ok(!/randomUUID|emitEvent|import\s*\(|server\/games|server\/prolog/.test(source));
  }
}
