import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameRegistry } from '../server/sdk/registry.mjs';
import { GamePluginLoader } from '../server/sdk/loader.mjs';
import { GameSessionFactory } from '../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../server/sdk/instance-manager.mjs';
import { GameEventAdapter } from '../server/sdk/event-adapter.mjs';
import { copyJSON } from '../server/sdk/values.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sdk-runtime/counter/', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = 'C:\\private\\plugin.mjs: internal-secret';

// EventSink contract: reject without retention, resolve only after local acceptance.
class MemorySink {
  events = [];
  attempts = [];
  beforeAccept = async () => {};
  async accept(event) {
    this.attempts.push(copyJSON(event));
    await this.beforeAccept(event);
    this.events.push(copyJSON(event));
  }
}

const observedSource = `
  export const contexts = new Map();
  export const cleanupCounts = new Map();
  export let cleanupFails = false;
  export const failCleanup = () => { cleanupFails = true; };
  export let snapshotFails = false;
  export const failSnapshot = () => { snapshotFails = true; };
  export default {
    initializationContract: {
      participants: [{id:'human',role:'human',required:true}],
      startData: {size:{type:'integer',required:true,equalsOption:'size'}}
    },
    createSession(context, options) {
      contexts.set(context.matchId, context);
      return {startData:{size:options.size},session:{
        getSnapshot(){if(snapshotFails) throw new Error('C:/private/plugin.mjs: internal-secret'); return {value:0};},
        dispatch(){return {outcome:'completed',committed:true};},
        finish(){
          cleanupCounts.set(context.matchId,(cleanupCounts.get(context.matchId)||0)+1);
          if(cleanupFails) throw new Error('C:/private/plugin.mjs: internal-secret');
        }
      }};
    }
  };`;

async function setup(t, { limit = 500, observe = false, noSink = false, source } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'gameconsole-sdk-2b1-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith('gameconsole-sdk-2b1-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'counter');
  await cp(fixture, directory, { recursive: true });
  if (observe || source) await writeFile(path.join(directory, 'server.mjs'), source ?? observedSource);
  const registry = new GameRegistry();
  await registry.register(directory);
  const factory = new GameSessionFactory(new GamePluginLoader(registry, { trustedIds: ['sdk-counter'] }));
  const sink = new MemorySink();
  const manager = new GameInstanceManager(factory, { limit, ...(noSink ? {} : { eventSink: sink }) });
  return { factory, manager, sink, moduleURL: pathToFileURL(registry.get('sdk-counter').paths.server).href };
}

function cleanError(error, code) {
  assert.equal(error.code, code);
  assert.ok(!error.message.includes('private'));
  assert.ok(!error.message.includes('internal-secret'));
  assert.ok(!error.stack.split('\n')[0].includes('plugin.mjs'));
  return true;
}

test('inicio único: IDs string, startData validado y sobre v1 de autoridad del host', async (t) => {
  const { manager, sink } = await setup(t);
  const prepared = await manager.create('sdk-counter', { options: { size: 28 }, players: [
    { id: 'human', role: 'human' }, { id: 'helper', role: 'ai' },
  ] });
  assert.equal(sink.events.length, 0);
  const before = Date.now();
  const [first, repeat] = await Promise.all([manager.activate(prepared.matchId), manager.activate(prepared.matchId)]);
  assert.equal(first.state, 'running');
  assert.equal(first.version, 0);
  assert.deepEqual(repeat, first);
  assert.equal(sink.events.length, 1);
  const event = sink.events[0];
  assert.deepEqual(Object.keys(event).sort(), ['schemaVersion', 'eventId', 'timestamp', 'gameId', 'gameVersion', 'matchId', 'type', 'data'].sort());
  assert.equal(event.schemaVersion, 1);
  assert.match(event.eventId, UUID);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(event.timestamp) >= before && Date.parse(event.timestamp) <= Date.now());
  assert.equal(event.gameId, 'sdk-counter');
  assert.equal(event.gameVersion, '1.0.0');
  assert.equal(event.matchId, prepared.matchId);
  assert.equal(event.type, 'MATCH_STARTED');
  assert.deepEqual(event.data, { size: 28, actor: 'human', players: ['human', 'helper'] });
});

test('no se publica running mientras el sink espera; otras instancias no se bloquean', { timeout: 5000 }, async (t) => {
  const { manager, sink } = await setup(t);
  const first = await manager.create('sdk-counter');
  const second = await manager.create('sdk-counter');
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sink.beforeAccept = async (event) => { if (event.matchId === first.matchId) { entered(); await gate; } };
  let activated = false;
  const activating = manager.activate(first.matchId).then((value) => { activated = true; return value; });
  await started;
  assert.equal(activated, false);
  assert.equal(sink.events.length, 0);
  assert.equal((await manager.activate(second.matchId)).state, 'running');
  release();
  assert.equal((await activating).state, 'running');
});

test('rechazo del inicio descarta, limpia, libera cuota y cancela operaciones encoladas', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true, limit: 1 });
  const probe = await import(moduleURL);
  const prepared = await manager.create('sdk-counter');
  sink.beforeAccept = async () => { throw new Error(SECRET); };
  const results = await Promise.allSettled([manager.activate(prepared.matchId), manager.activate(prepared.matchId)]);
  cleanError(results[0].reason, 'ACTIVATION_FAILED');
  assert.equal(results[0].reason.failureCode, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(results[1].reason.code, 'UNKNOWN_MATCH');
  assert.equal(manager.size, 0);
  assert.deepEqual(sink.events, []);
  assert.equal(probe.cleanupCounts.get(prepared.matchId), 1);
  assert.equal(probe.contexts.get(prepared.matchId).signal.aborted, true);
  await assert.rejects(manager.getSnapshot(prepared.matchId), { code: 'UNKNOWN_MATCH' });
  sink.beforeAccept = async () => {};
  const next = await manager.create('sdk-counter');
  assert.notEqual(next.matchId, prepared.matchId);
  assert.equal((await manager.activate(next.matchId)).state, 'running');
});

test('inicio fallido libera cuota aun si falla la limpieza; sink no configurado nunca activa', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true, limit: 1 });
  (await import(moduleURL)).failCleanup();
  const prepared = await manager.create('sdk-counter');
  sink.beforeAccept = async () => { throw new Error(SECRET); };
  await assert.rejects(manager.activate(prepared.matchId), (error) => {
    cleanError(error, 'ACTIVATION_FAILED');
    assert.equal(error.cleanupErrorCode, 'CLEANUP_FAILED');
    return true;
  });
  assert.equal(manager.size, 0);
  assert.equal((await manager.create('sdk-counter')).state, 'prepared');
  const missing = await setup(t, { noSink: true });
  const local = await missing.manager.create('sdk-counter');
  await assert.rejects(missing.manager.activate(local.matchId), (error) => {
    assert.equal(error.failureCode, 'EVENT_SINK_UNAVAILABLE');
    return cleanError(error, 'ACTIVATION_FAILED');
  });
  assert.equal(missing.manager.size, 0);
});

test('cierre activo único, ordenado y con identidad independiente por partida', async (t) => {
  const { manager, sink } = await setup(t);
  const first = await manager.create('sdk-counter');
  const second = await manager.create('sdk-counter');
  await Promise.all([manager.activate(first.matchId), manager.activate(second.matchId)]);
  const [closed, repeat] = await Promise.all([
    manager.finish(first.matchId, { reason: 'completed' }), manager.finish(first.matchId),
  ]);
  assert.equal(closed.state, 'finished');
  assert.equal(closed.version, 1);
  assert.deepEqual(repeat, closed);
  assert.equal((await manager.getSnapshot(second.matchId)).state, 'running');
  await manager.finish(second.matchId);
  const ids = new Set(sink.events.map((event) => event.eventId));
  assert.equal(ids.size, 4);
  for (const match of [first, second]) {
    assert.match(match.matchId, UUID);
    const events = sink.events.filter((event) => event.matchId === match.matchId);
    assert.deepEqual(events.map((event) => event.type), ['MATCH_STARTED', 'MATCH_FINISHED']);
    assert.ok(events.every((event) => event.gameId === match.gameId && event.gameVersion === match.gameVersion));
  }
  assert.deepEqual(sink.events.find((event) => event.type === 'MATCH_FINISHED').data, { reason: 'completed' });
});

test('descarte y cierre no activados no generan eventos; descarte libera cuota', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true, limit: 1 });
  const first = await manager.create('sdk-counter');
  await manager.discard(first.matchId);
  assert.equal(manager.size, 0);
  await assert.rejects(manager.discard(first.matchId), { code: 'UNKNOWN_MATCH' });
  const second = await manager.create('sdk-counter');
  const closed = await manager.finish(second.matchId);
  assert.equal(closed.state, 'finished');
  assert.equal(closed.version, 1);
  await assert.rejects(manager.activate(second.matchId), { code: 'INVALID_LIFECYCLE' });
  assert.equal(manager.size, 1); // Legacy 2A finish retains the terminal report/quota.
  assert.deepEqual(sink.events, []);
  const probe = await import(moduleURL);
  assert.equal(probe.cleanupCounts.get(first.matchId), 1);
  assert.equal(probe.cleanupCounts.get(second.matchId), 1);
});

test('rechazo del cierre conserva closing y reintenta el mismo evento sin repetir limpieza', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true });
  const probe = await import(moduleURL);
  const first = await manager.create('sdk-counter');
  await manager.activate(first.matchId);
  let reject = true;
  sink.beforeAccept = async (event) => { if (event.type === 'MATCH_FINISHED' && reject) throw new Error(SECRET); };
  await assert.rejects(manager.finish(first.matchId, { reason: 'completed' }), (error) => cleanError(error, 'EVENT_ACCEPTANCE_FAILED'));
  const pending = await manager.getSnapshot(first.matchId);
  assert.equal(pending.state, 'closing');
  assert.equal(pending.version, 0);
  assert.equal(sink.events.length, 1);
  assert.equal(probe.contexts.get(first.matchId).signal.aborted, true);
  assert.equal(probe.cleanupCounts.get(first.matchId), 1);
  await assert.rejects(manager.activate(first.matchId), { code: 'INVALID_LIFECYCLE' });
  await assert.rejects(manager.discard(first.matchId), { code: 'INVALID_LIFECYCLE' });
  reject = false;
  const terminal = await manager.finish(first.matchId, { reason: 'different-retry-reason' });
  assert.equal(terminal.state, 'finished');
  assert.equal(terminal.version, 1);
  assert.equal(probe.cleanupCounts.get(first.matchId), 1);
  const attempts = sink.attempts.filter((event) => event.type === 'MATCH_FINISHED');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[1].data.reason, 'completed');
  await manager.finish(first.matchId);
  assert.equal(sink.events.length, 2);
});

test('fallo de limpieza bloquea operaciones, conserva cierre único y no filtra el error', async (t) => {
  const { factory, manager, sink, moduleURL } = await setup(t, { observe: true });
  const prepare = factory.prepare.bind(factory);
  let handle;
  factory.prepare = async (...args) => { handle = await prepare(...args); return handle; };
  const first = await manager.create('sdk-counter');
  const probe = await import(moduleURL);
  probe.failCleanup();
  await manager.activate(first.matchId);
  await assert.rejects(manager.finish(first.matchId), (error) => cleanError(error, 'CLEANUP_FAILED'));
  const terminal = await manager.getSnapshot(first.matchId);
  assert.equal(terminal.state, 'finished');
  assert.equal(terminal.version, 1);
  assert.throws(() => handle.session.dispatch({ type: 'ADD' }), { code: 'SESSION_CLOSED' });
  assert.throws(() => probe.contexts.get(first.matchId).emitEvent({ type: 'SCORE', data: {} }), { code: 'EVENTS_UNAVAILABLE' });
  assert.equal(probe.contexts.get(first.matchId).signal.aborted, true);
  assert.deepEqual(await manager.finish(first.matchId), terminal);
  assert.equal(probe.cleanupCounts.get(first.matchId), 1);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'MATCH_FINISHED']);
});

test('fallos combinados conservan el error de limpieza hasta aceptar el cierre', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true });
  const probe = await import(moduleURL);
  probe.failCleanup();
  const first = await manager.create('sdk-counter');
  await manager.activate(first.matchId);
  sink.beforeAccept = async () => { throw new Error(SECRET); };
  await assert.rejects(manager.finish(first.matchId), { code: 'EVENT_ACCEPTANCE_FAILED' });
  assert.equal((await manager.getSnapshot(first.matchId)).state, 'closing');
  sink.beforeAccept = async () => {};
  await assert.rejects(manager.finish(first.matchId), (error) => cleanError(error, 'CLEANUP_FAILED'));
  assert.equal((await manager.getSnapshot(first.matchId)).state, 'finished');
  await manager.finish(first.matchId);
  assert.equal(probe.cleanupCounts.get(first.matchId), 1);
  assert.equal(sink.events.length, 2);
});

test('lectura fallida durante activación descarta; durante cierre conserva el último reporte válido', async (t) => {
  for (const when of ['activation', 'finish']) {
    const { manager, sink, moduleURL } = await setup(t, { observe: true });
    const probe = await import(moduleURL);
    const first = await manager.create('sdk-counter');
    if (when === 'finish') await manager.activate(first.matchId);
    probe.failSnapshot();
    if (when === 'activation') {
      await assert.rejects(manager.activate(first.matchId), (error) => {
        assert.equal(error.failureCode, 'INVALID_SNAPSHOT');
        return cleanError(error, 'ACTIVATION_FAILED');
      });
      assert.equal(manager.size, 0);
      assert.deepEqual(sink.events, []);
    } else {
      await assert.rejects(manager.finish(first.matchId), (error) => cleanError(error, 'INVALID_SNAPSHOT'));
      const terminal = await manager.getSnapshot(first.matchId);
      assert.equal(terminal.state, 'finished');
      assert.deepEqual(terminal.data, { value: 0 });
      assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'MATCH_FINISHED']);
      await manager.finish(first.matchId);
      assert.equal(sink.events.length, 2);
    }
    assert.equal(probe.cleanupCounts.get(first.matchId), 1);
  }
});

test('descarte libera cuota incluso si falla la limpieza sin inventar eventos', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true, limit: 1 });
  const first = await manager.create('sdk-counter');
  (await import(moduleURL)).failCleanup();
  await assert.rejects(manager.discard(first.matchId), (error) => cleanError(error, 'CLEANUP_FAILED'));
  assert.equal(manager.size, 0);
  assert.deepEqual(sink.events, []);
  assert.equal((await manager.create('sdk-counter')).state, 'prepared');
});

test('permisos del contexto impiden eventos reservados y mantienen dominio deshabilitado', async (t) => {
  const { manager, sink, moduleURL } = await setup(t, { observe: true });
  const first = await manager.create('sdk-counter');
  const context = (await import(moduleURL)).contexts.get(first.matchId);
  assert.throws(() => context.emitEvent({ type: 'SCORE', data: {} }), { code: 'EVENTS_UNAVAILABLE' });
  await manager.activate(first.matchId);
  for (const type of ['MATCH_STARTED', 'MATCH_FINISHED']) {
    assert.throws(() => context.emitEvent({ type, data: {} }), { code: 'RESERVED_EVENT' });
  }
  assert.throws(() => context.finishMatch({ reason: 'completed' }), { code: 'EVENTS_UNAVAILABLE' });
  assert.throws(() => context.emitEvent({ type: 'SCORE', data: {} }), { code: 'EVENTS_UNAVAILABLE' });
  assert.equal(sink.events.length, 1);
  assert.equal(Object.hasOwn(context, 'eventSink'), false);
  assert.equal(Object.hasOwn(context, 'outbox'), false);
});

test('adaptador rechaza suplantación, playerId ajeno y datos no serializables', () => {
  const identity = { gameId: 'test-plugin', gameVersion: '1.0.0', matchId: 'host-match', players: [{ id: 'human', role: 'human' }] };
  const adapter = new GameEventAdapter(identity);
  identity.players[0].id = 'changed';
  const descriptor = { type: 'SCORE', data: { points: 1 }, playerId: 'human' };
  const event = adapter.createDomainEvent(descriptor);
  descriptor.data.points = 100;
  assert.equal(event.playerId, 'human');
  assert.equal(event.data.points, 1);
  assert.equal(event.matchId, 'host-match');
  assert.match(event.eventId, UUID);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.data));
  for (const key of ['schemaVersion', 'eventId', 'timestamp', 'gameId', 'gameVersion', 'matchId']) {
    assert.throws(() => adapter.createDomainEvent({ ...descriptor, [key]: 'fake' }), { code: 'INVALID_EVENT' });
  }
  for (const playerId of ['unknown', '', null]) {
    assert.throws(() => adapter.createDomainEvent({ ...descriptor, playerId }), { code: 'INVALID_EVENT_PLAYER' });
  }
  for (const type of ['MATCH_STARTED', 'MATCH_FINISHED']) {
    assert.throws(() => adapter.createDomainEvent({ type, data: {} }), { code: 'RESERVED_EVENT' });
  }
  for (const data of [null, [], { value: undefined }, { value: Infinity }, { value: 1n }]) {
    assert.throws(() => adapter.createDomainEvent({ type: 'SCORE', data }), { code: 'INVALID_EVENT' });
  }
  assert.throws(() => adapter.createMatchStarted({ players: ['fake'] }), { code: 'INVALID_EVENT' });
  assert.throws(() => adapter.createDomainEvent({ type: 'SCORE', data: { text: 'x'.repeat(1024 * 1024) } }), { code: 'EVENT_TOO_LARGE' });
  assert.equal(Object.hasOwn(adapter.createMatchFinished({ reason: 'completed' }), 'playerId'), false);
});
