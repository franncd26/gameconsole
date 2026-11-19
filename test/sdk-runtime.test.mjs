import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameRegistry, discoverPlugins } from '../server/sdk/registry.mjs';
import { GamePluginLoader } from '../server/sdk/loader.mjs';
import { GameSessionFactory } from '../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../server/sdk/instance-manager.mjs';
import { validateOptions } from '../server/sdk/options.mjs';
import { copyJSON } from '../server/sdk/values.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sdk-runtime/counter/', import.meta.url));
const template = JSON.parse(await readFile(path.join(fixture, 'game.json'), 'utf8'));

async function setup(t, { change = () => {}, source, trusted = true, limit = 500 } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'gameconsole-sdk-2a-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith('gameconsole-sdk-2a-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'counter');
  await cp(fixture, directory, { recursive: true });
  const manifest = structuredClone(template);
  change(manifest);
  await writeFile(path.join(directory, 'game.json'), JSON.stringify(manifest));
  if (source !== undefined) await writeFile(path.join(directory, 'server.mjs'), source);
  const registry = new GameRegistry();
  await registry.register(directory);
  const loader = new GamePluginLoader(registry, { trustedIds: trusted ? [manifest.id] : [] });
  const factory = new GameSessionFactory(loader);
  const manager = new GameInstanceManager(factory, { limit });
  return { root, directory, registry, loader, factory, manager };
}

test('discovery no importa plugins, incluso cuando se prepara un loader', async (t) => {
  const { root, loader } = await setup(t);
  assert.equal(globalThis.__sdkCounterImported, undefined);
  const { registry, errors } = await discoverPlugins(root);
  assert.equal(registry.list().length, 1);
  assert.deepEqual(errors, []);
  assert.equal(globalThis.__sdkCounterImported, undefined);
  const [first, second] = await Promise.all([loader.load('sdk-counter'), loader.load('sdk-counter')]);
  assert.equal(first, second);
  assert.equal(globalThis.__sdkCounterImported, true);
  assert.ok(Object.isFrozen(first.initializationContract));
});

test('loader rechaza plugins desconocidos, paths y módulos no autorizados', async (t) => {
  const { loader } = await setup(t, { trusted: false });
  await assert.rejects(loader.load('sdk-counter'), { code: 'UNTRUSTED_PLUGIN' });
  for (const id of ['unknown', '../counter/server.mjs', 'file:///private.mjs']) {
    await assert.rejects(loader.load(id), { code: 'UNKNOWN_PLUGIN' });
  }
});

test('loader valida exports, contrato y errores de importación sin filtrar detalles', async (t) => {
  for (const source of [
    'export const createSession = () => {};',
    'export default {createSession(){}};',
    'export default {createSession(){}, initializationContract: {participants: [], startData: {}}};',
  ]) {
    const { loader } = await setup(t, { source });
    await assert.rejects(loader.load('sdk-counter'), { code: 'INVALID_PLUGIN_INTERFACE' });
  }
  const { loader } = await setup(t, { source: 'throw new Error("private-path-and-secret");' });
  await assert.rejects(loader.load('sdk-counter'), (error) => {
    assert.equal(error.code, 'PLUGIN_LOAD_FAILED');
    assert.ok(!error.message.includes('private-path-and-secret'));
    return true;
  });
});

test('loader comprueba de nuevo el paquete registrado antes de importar', async (t) => {
  const { directory, loader } = await setup(t);
  await writeFile(path.join(directory, 'game.json'), '{}');
  await assert.rejects(loader.load('sdk-counter'), { code: 'PLUGIN_CHANGED' });
});

test('opciones aplican defaults y validan todos los tipos sin coerción', () => {
  const result = validateOptions(template);
  assert.deepEqual(result, { initial: 0, size: 20, sound: false, label: 'Counter', mode: 'normal' });
  assert.ok(Object.isFrozen(result));
  assert.equal(validateOptions(template, { size: 12 }).size, 12);
  assert.equal(validateOptions(template, { size: 28 }).size, 28);
  for (const options of [null, [], { other: 1 }, { initial: 11 }, { initial: 1.5 }, { size: 16 },
    { size: '20' }, { sound: 1 }, { label: '' }, { label: ' x ' }, { mode: 'unknown' }, { size: undefined }]) {
    assert.throws(() => validateOptions(template, options), { code: 'INVALID_OPTIONS' });
  }
});

test('fábrica crea UUID propios, protege entradas y aísla datos entre sesiones', async (t) => {
  const { factory } = await setup(t);
  const config = { options: { initial: 2 }, players: [{ id: 'human', role: 'human' }] };
  const firstPromise = factory.prepare('sdk-counter', config);
  config.options.initial = 9;
  config.players[0].role = 'changed';
  const [first, second] = await Promise.all([firstPromise, factory.prepare('sdk-counter')]);
  t.after(async () => { await first.dispose('test'); await second.dispose('test'); });
  assert.notEqual(first.matchId, second.matchId);
  assert.match(first.matchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal((await first.readData()).value, 2);
  assert.equal((await first.readData()).protectedInputs, true);
  await first.session.dispatch({ type: 'ADD', payload: { amount: 3 } });
  assert.equal((await first.readData()).value, 5);
  assert.equal((await second.readData()).value, 0);
});

test('participantes se validan por declaración y datos de inicio por tipo, opción e identidad', async (t) => {
  const { factory, manager } = await setup(t);
  for (const players of [[], [{ id: 'unknown', role: 'human' }], [{ id: 'human', role: 'ai' }],
    [{ id: 'human', role: 'human' }, { id: 'human', role: 'human' }], [{ id: 'helper', role: 'ai' }]]) {
    await assert.rejects(manager.create('sdk-counter', { players }), { code: 'INVALID_PLAYERS' });
  }
  const prepared = await factory.prepare('sdk-counter', { players: [
    { id: 'human', role: 'human' }, { id: 'helper', role: 'ai' },
  ] });
  assert.equal(prepared.players.length, 2);
  await prepared.dispose('test');
  assert.equal(manager.size, 0);
});

test('fallos de preparación y eventos prohibidos nunca publican una instancia', async (t) => {
  const { manager } = await setup(t, { limit: 1 });
  for (const [mode, code] of [
    ['throw', 'PREPARATION_FAILED'], ['event', 'PREPARATION_FAILED'],
    ['caught-event', 'EVENT_DURING_PREPARATION'], ['bad-start', 'INVALID_START_DATA'],
    ['missing-start', 'INVALID_START_DATA'], ['bad-player', 'INVALID_START_DATA'],
    ['bad-snapshot', 'INVALID_SNAPSHOT'], ['bad-session', 'INVALID_SESSION_INTERFACE'],
  ]) {
    await assert.rejects(manager.create('sdk-counter', { options: { mode } }), { code });
    assert.equal(manager.size, 0);
  }
  await assert.rejects(manager.create('missing'), { code: 'UNKNOWN_PLUGIN' });
  await assert.rejects(manager.create('sdk-counter', { options: { size: 16 } }), { code: 'INVALID_OPTIONS' });
  assert.equal(manager.size, 0);
  assert.equal((await manager.create('sdk-counter')).state, 'prepared');
});

test('snapshots y listados son defensivos, JSON y sin rutas de archivos', async (t) => {
  const { manager } = await setup(t);
  const first = await manager.create('sdk-counter');
  const id = first.matchId;
  first.data.history.push(100);
  first.options.size = 13;
  first.players[0].role = 'changed';
  first.startData.actor = 'changed';
  const listed = await manager.list();
  listed[0].data.value = 99;
  const fresh = await manager.getSnapshot(id);
  assert.deepEqual(fresh.data.history, []);
  assert.equal(fresh.data.value, 0);
  assert.equal(fresh.options.size, 20);
  assert.equal(fresh.players[0].role, 'human');
  assert.equal(fresh.startData.actor, 'human');
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), fresh);
  assert.ok(!JSON.stringify(fresh).includes('server.mjs'));
  await assert.rejects(manager.getSnapshot('missing'), { code: 'UNKNOWN_MATCH' });
  const finished = await manager.finish(id);
  assert.equal(finished.state, 'finished');
  assert.equal(finished.version, 1);
  assert.deepEqual(await manager.finish(id), finished);
  assert.equal(manager.size, 1);
});

test('copias JSON rechazan valores silenciosamente alterados por JSON.stringify', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const getter = { get value() { throw new Error('must not execute'); } };
  for (const value of [{ v: undefined }, { v: NaN }, { v: Infinity }, { v: 1n },
    { v: () => {} }, new Date(), cyclic, getter, { v: Array(1) }]) {
    assert.throws(() => copyJSON(value), { code: 'INVALID_JSON_VALUE' });
  }
});

test('el límite incluye reservas concurrentes y las partidas finalizadas', async (t) => {
  const { factory, manager } = await setup(t, { limit: 2 });
  assert.throws(() => new GameInstanceManager(factory, { limit: 501 }), { code: 'INVALID_CONFIGURATION' });
  const results = await Promise.allSettled([manager.create('sdk-counter'), manager.create('sdk-counter'), manager.create('sdk-counter')]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.code, 'INSTANCE_LIMIT');
  await manager.finish(results[0].value.matchId);
  await assert.rejects(manager.create('sdk-counter'), { code: 'INSTANCE_LIMIT' });
});

test('el límite predeterminado admite 500 partidas y rechaza la 501', async (t) => {
  const { manager } = await setup(t);
  for (let index = 0; index < 500; index++) await manager.create('sdk-counter');
  assert.equal(manager.size, 500);
  await assert.rejects(manager.create('sdk-counter'), { code: 'INSTANCE_LIMIT' });
});

test('multipleInstances false no publica dos sesiones ante creaciones concurrentes', async (t) => {
  const { manager } = await setup(t, { change: (m) => { m.capabilities.multipleInstances = false; } });
  const results = await Promise.allSettled([manager.create('sdk-counter'), manager.create('sdk-counter')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'MULTIPLE_INSTANCES_DISABLED');
  const first = results.find((result) => result.status === 'fulfilled').value;
  await manager.finish(first.matchId);
  assert.equal((await manager.create('sdk-counter')).state, 'prepared');
});

test('colas por partida serializan snapshots y cierre sin bloquear otra partida', { timeout: 5000 }, async (t) => {
  const source = `
    let probe = async () => {};
    export const setProbe = (fn) => { probe = fn; };
    export default {
      initializationContract: { participants: [{id:'human',role:'human',required:true}], startData: {} },
      createSession(context) { return { startData: {}, session: {
        async getSnapshot() { await probe(context.matchId); return {value:0}; },
        dispatch() {}, finish() {}
      }}; }
    };`;
  const { registry, manager } = await setup(t, { source });
  const first = await manager.create('sdk-counter');
  const second = await manager.create('sdk-counter');
  const module = await import(pathToFileURL(registry.get('sdk-counter').paths.server).href);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  module.setProbe(async (id) => { if (id === first.matchId) { entered(); await gate; } });
  const reading = manager.getSnapshot(first.matchId);
  await started;
  let closed = false;
  const closing = manager.finish(first.matchId).then((snapshot) => { closed = true; return snapshot; });
  assert.equal((await manager.getSnapshot(second.matchId)).state, 'prepared');
  assert.equal(closed, false);
  release();
  assert.equal((await reading).state, 'prepared');
  assert.equal((await closing).state, 'finished');
});

test('fábrica rechaza reutilizar un objeto de sesión sin cerrar la instancia propietaria', async (t) => {
  const source = `
    let closed = false;
    const shared = {getSnapshot(){return {closed};}, dispatch(){}, finish(){closed=true;}};
    export default {
      initializationContract: {participants:[{id:'human',role:'human',required:true}],startData:{}},
      createSession(){return {session:shared,startData:{}};}
    };`;
  const { manager } = await setup(t, { source });
  const first = await manager.create('sdk-counter');
  await assert.rejects(manager.create('sdk-counter'), { code: 'REUSED_SESSION' });
  assert.equal((await manager.getSnapshot(first.matchId)).data.closed, false);
  assert.equal(manager.size, 1);
});

test('el cierre sigue siendo terminal aunque fallen snapshot o limpieza del plugin', async (t) => {
  for (const failure of ['snapshot', 'cleanup']) {
    const source = `
      let broken = false;
      export const breakSession = () => { broken = true; };
      export default {
        initializationContract: {participants:[{id:'human',role:'human',required:true}],startData:{}},
        createSession(){return {startData:{},session:{
          getSnapshot(){if(broken && '${failure}'==='snapshot') throw new Error('private'); return {value:0};},
          dispatch(){}, finish(){if('${failure}'==='cleanup') throw new Error('private');}
        }};}
      };`;
    const { registry, manager } = await setup(t, { source });
    const first = await manager.create('sdk-counter');
    const module = await import(pathToFileURL(registry.get('sdk-counter').paths.server).href);
    module.breakSession();
    await assert.rejects(manager.finish(first.matchId), { code: failure === 'snapshot' ? 'INVALID_SNAPSHOT' : 'CLEANUP_FAILED' });
    const terminal = await manager.getSnapshot(first.matchId);
    assert.equal(terminal.state, 'finished');
    assert.equal(terminal.version, 1);
    assert.deepEqual(terminal.data, { value: 0 });
    assert.deepEqual(await manager.finish(first.matchId), terminal);
  }
});
