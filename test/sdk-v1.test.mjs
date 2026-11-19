import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, validateManifest } from '../server/sdk/manifest.mjs';
import { discoverPlugins } from '../server/sdk/registry.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sdk-v1/example/', import.meta.url));
const template = JSON.parse(await readFile(path.join(fixture, 'game.json'), 'utf8'));

async function workspace(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, 'gameconsole-sdk-v1-'));
  t.after(async () => {
    // Verify the exact recursive cleanup target stays within this test's temp root.
    assert.equal(path.dirname(path.resolve(directory)), tempRoot);
    assert.ok(path.basename(directory).startsWith('gameconsole-sdk-v1-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function packageAt(root, name, change = () => {}) {
  const directory = path.join(root, name);
  await cp(fixture, directory, { recursive: true });
  const manifest = structuredClone(template);
  change(manifest);
  await writeFile(path.join(directory, 'game.json'), JSON.stringify(manifest));
  return directory;
}

test('valida un manifiesto completo y devuelve una copia defensiva', async () => {
  const result = validateManifest(template);
  result.options[0].values.push('other');
  assert.equal(template.options[0].values.length, 2);
  const loaded = await loadManifest(fixture);
  assert.equal(loaded.manifest.id, 'sdk-example');
  assert.ok(path.isAbsolute(loaded.paths.server));
});

test('rechaza versiones, campos desconocidos y valores incompatibles', () => {
  const cases = [
    (m) => { m.manifestVersion = 2; },
    (m) => { m.sdkVersion = '1.1'; },
    (m) => { m.future = true; },
    (m) => { m.entrypoints.loader = 'x.mjs'; },
    (m) => { m.id = '../bad'; },
    (m) => { m.id = 'Upper'; },
    (m) => { m.name = 'x'.repeat(81); },
    (m) => { m.version = 'latest'; },
    (m) => { m.capabilities.ai = 'true'; },
    (m) => { m.capabilities.pause = true; },
    (m) => { m.players.max = 0; },
    (m) => { m.players.max = 1.5; },
    (m) => { m.options.push(m.options[0]); },
    (m) => { m.options[0].values.push('easy'); },
    (m) => { m.options[0].default = 'unknown'; },
    (m) => { m.options[1].default = 21; },
    (m) => { m.options[2].default = 0; },
    (m) => { m.options[3].maxLength = 0; },
    (m) => { m.analytics.extra = true; },
  ];
  for (const change of cases) {
    const manifest = structuredClone(template);
    change(manifest);
    assert.throws(() => validateManifest(manifest), { name: 'ManifestError' });
  }
  assert.throws(() => validateManifest({ ...template, sdkVersion: '2.0' }), { code: 'INCOMPATIBLE_VERSION' });
});

test('rechaza traversal, rutas absolutas, alternativas Windows y URLs en todas las rutas', () => {
  for (const value of ['../outside.mjs', '/outside.mjs', 'C:/private.mjs', 'a/../../outside.mjs',
    'a\\outside.mjs', 'a//outside.mjs', './server.mjs', 'file:///x.mjs', '%2e%2e/x.mjs', 'NUL.mjs']) {
    for (const key of ['server', 'web']) {
      const manifest = structuredClone(template);
      manifest.entrypoints[key] = value;
      assert.throws(() => validateManifest(manifest), { code: 'UNSAFE_PATH' });
    }
  }
  assert.throws(() => validateManifest({ ...template, analytics: { profile: '../secret.json' } }), { code: 'UNSAFE_PATH' });
});

test('rechaza JSON inválido, tamaño excesivo y archivos faltantes sin filtrar rutas', async (t) => {
  const root = await workspace(t);
  const directory = await packageAt(root, 'broken');
  for (const source of ['{ sensitive-content', ' '.repeat(65537)]) {
    await writeFile(path.join(directory, 'game.json'), source);
    await assert.rejects(loadManifest(directory), (error) => {
      assert.equal(error.code, 'INVALID_JSON');
      assert.ok(!error.message.includes(root));
      assert.ok(!error.message.includes('sensitive-content'));
      return true;
    });
  }
  for (const change of [
    (m) => { m.entrypoints.server = 'missing.mjs'; },
    (m) => { m.entrypoints.web = 'missing.mjs'; },
    (m) => { m.analytics.profile = 'missing.json'; },
  ]) {
    const manifest = structuredClone(template);
    change(manifest);
    await writeFile(path.join(directory, 'game.json'), JSON.stringify(manifest));
    await assert.rejects(loadManifest(directory), { code: 'INVALID_PATH' });
  }
});

test('duplicados conservan el primer paquete válido en orden determinista', async (t) => {
  const root = await workspace(t);
  await packageAt(root, 'z-last', (m) => { m.name = 'Último'; });
  await packageAt(root, 'a-first', (m) => { m.name = 'Primero'; });
  const { registry, errors } = await discoverPlugins(root);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('sdk-example').manifest.name, 'Primero');
  assert.deepEqual(errors.map(({ candidate, code }) => ({ candidate, code })), [
    { candidate: 'z-last', code: 'DUPLICATE_ID' },
  ]);
});

test('un paquete inválido se aísla; list se ordena por id', async (t) => {
  const root = await workspace(t);
  await packageAt(root, 'a-invalid', (m) => { m.manifestVersion = 5; });
  await packageAt(root, 'b-valid', (m) => { m.id = 'z-game'; });
  await packageAt(root, 'c-valid', (m) => { m.id = 'a-game'; });
  await writeFile(path.join(root, 'ignored.txt'), 'not a package');
  const { registry, errors } = await discoverPlugins(root);
  assert.deepEqual(registry.list().map((p) => p.manifest.id), ['a-game', 'z-game']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'INCOMPATIBLE_VERSION');
});

test('directorio ausente produce catálogo vacío; otros errores se reportan', async (t) => {
  const root = await workspace(t);
  const { registry, errors } = await discoverPlugins(path.join(root, 'missing'));
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(errors, []);
  const file = path.join(root, 'file');
  await writeFile(file, '');
  assert.equal((await discoverPlugins(file)).errors[0].code, 'DISCOVERY_IO');
});

test('catálogo público sin rutas de carga y APIs con copias defensivas', async (t) => {
  const root = await workspace(t);
  await packageAt(root, 'example');
  const { registry } = await discoverPlugins(root);
  const catalog = registry.publicCatalog();
  assert.deepEqual(Object.keys(catalog[0]).sort(),
    ['id', 'name', 'version', 'description', 'category', 'capabilities', 'players', 'options'].sort());
  const serialized = JSON.stringify(catalog);
  for (const forbidden of [root, 'server.mjs', 'web.mjs', 'profile.json', 'entrypoints', 'directory', 'paths']) {
    assert.ok(!serialized.includes(forbidden));
  }
  catalog[0].options[0].values.push('mutated');
  registry.get('sdk-example').manifest.players.min = 99;
  registry.list()[0].manifest.name = 'mutated';
  assert.equal(registry.publicCatalog()[0].options[0].values.length, 2);
  assert.equal(registry.get('sdk-example').manifest.players.min, 1);
  assert.equal(registry.get('unknown'), undefined);
  assert.equal(registry.list()[0].manifest.name, template.name);
});

test('discovery nunca importa ni ejecuta los entrypoints', async () => {
  assert.equal(globalThis.__sdkFixtureServerExecuted, undefined);
  assert.equal(globalThis.__sdkFixtureWebExecuted, undefined);
  const { registry, errors } = await discoverPlugins(path.dirname(fixture));
  assert.equal(registry.list().length, 1);
  assert.deepEqual(errors, []);
  assert.equal(globalThis.__sdkFixtureServerExecuted, undefined);
  assert.equal(globalThis.__sdkFixtureWebExecuted, undefined);
});

test('rutas reales impiden escape por symlink/junction y candidatos enlazados', async (t) => {
  const root = await workspace(t);
  const plugins = path.join(root, 'plugins');
  await mkdir(plugins);
  const outside = await packageAt(root, 'outside');
  const directory = await packageAt(plugins, 'example', (m) => { m.entrypoints.server = 'linked/server.mjs'; });
  try {
    await symlink(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(outside, path.join(plugins, 'linked-package'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('El sistema no permite crear enlaces simbólicos/junctions');
      return;
    }
    throw error;
  }
  await assert.rejects(loadManifest(directory), { code: 'UNSAFE_PATH' });
  const { registry, errors } = await discoverPlugins(plugins);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(errors.map((error) => error.code), ['UNSAFE_PATH', 'UNSAFE_PATH']);
});
