import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameRegistry } from '../server/sdk/registry.mjs';
import { GamePluginLoader } from '../server/sdk/loader.mjs';
import { GameSessionFactory } from '../server/sdk/session-factory.mjs';
import { GameInstanceManager } from '../server/sdk/instance-manager.mjs';
import { copyJSON } from '../server/sdk/values.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sdk-runtime/counter/', import.meta.url));
const source = await readFile(new URL('./fixtures/sdk-actions/plugin.mjs', import.meta.url), 'utf8');
const transitions = await readFile(new URL('./fixtures/sdk-transitions/plugin.mjs', import.meta.url), 'utf8');
const action = (requestId, amount = 1, expectedVersion) => ({ requestId, type: 'ADD', payload: { amount },
  ...(expectedVersion === undefined ? {} : { expectedVersion }) });

async function setup(t, { requestHistoryLimit, legacy = false } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'gameconsole-sdk-actions-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith('gameconsole-sdk-actions-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'counter');
  await cp(fixture, directory, { recursive: true });
  if (!legacy) {
    await writeFile(path.join(directory, 'transitions.mjs'), transitions);
    await writeFile(path.join(directory, 'server.mjs'), source);
  }
  const registry = new GameRegistry();
  await registry.register(directory);
  const factory = new GameSessionFactory(new GamePluginLoader(registry, { trustedIds: ['sdk-counter'] }));
  const sink = {
    events: [], failType: undefined, beforeAccept: async () => {},
    async accept(event) {
      await this.beforeAccept(event);
      if (event.type === this.failType) throw new Error('C:/private/sink.mjs: secret');
      this.events.push(copyJSON(event));
    },
    async acceptBatch(events) { this.events.push(...events.map((event) => copyJSON(event))); },
  };
  const manager = new GameInstanceManager(factory, { eventSink: sink,
    ...(requestHistoryLimit === undefined ? {} : { requestHistoryLimit }) });
  const prepared = await manager.create('sdk-counter');
  const probe = legacy ? null : await import(pathToFileURL(registry.get('sdk-counter').paths.server).href);
  const activate = () => manager.activate(prepared.matchId);
  const send = (input) => manager.dispatch(prepared.matchId, input);
  const callCount = () => probe?.calls.get(prepared.matchId) ?? 0;
  return { factory, manager, sink, prepared, probe, activate, send, callCount };
}

test('dispatch entrega copia profundamente protegida y devuelve solo JSON defensivo', async (t) => {
  const { manager, sink, prepared, probe, activate, send, callCount } = await setup(t);
  await activate();
  const input = { ...action('one', 2, 0), payload: { amount: 2, nested: { list: [1, 2] } } };
  const pending = send(input);
  input.payload.amount = 99;
  input.payload.nested.list.push(3);
  const result = await pending;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.committed, true);
  assert.equal(result.confirmations, 1);
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.snapshot.data.count, 2);
  assert.equal(callCount(), 1);
  const received = probe.received.get(prepared.matchId);
  assert.ok(Object.isFrozen(received) && Object.isFrozen(received.payload) && Object.isFrozen(received.payload.nested.list));
  assert.deepEqual(received.payload.nested.list, [1, 2]);
  assert.equal(received.payload.amount, 2);
  assert.throws(() => { received.payload.nested.list.push(4); }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(Object.keys(result).sort(), ['outcome', 'committed', 'confirmations', 'snapshot'].sort());
  result.snapshot.data.count = 123;
  assert.equal((await manager.getSnapshot(prepared.matchId)).data.count, 2);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED']);
});

test('el plugin decide nombres y payload: acción desconocida se rechaza sin lista específica del host', async (t) => {
  const { activate, send, callCount, sink } = await setup(t);
  await activate();
  const unknown = { requestId: 'unknown', type: 'SOME_UNKNOWN_ACTION', payload: {} };
  const rejected = await send(unknown);
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.committed, false);
  assert.equal(rejected.snapshot.version, 0);
  assert.equal(callCount(), 1);
  assert.deepEqual(await send(unknown), rejected);
  assert.equal(callCount(), 1);
  const accepted = await send({ requestId: 'custom', type: 'CUSTOM_NOOP', payload: {} });
  assert.equal(accepted.outcome, 'completed');
  assert.equal(accepted.confirmations, 0);
  assert.equal(sink.events.length, 1);
});

test('sobres malformados, accesores, ciclos y tipos no JSON nunca ejecutan código ni el plugin', async (t) => {
  const { activate, send, callCount, sink } = await setup(t);
  await activate();
  let executed = false;
  const cyclic = {}; cyclic.self = cyclic;
  const valid = action('bad');
  const cases = [null, [], 'server.mjs', () => { executed = true; }, {},
    { ...valid, requestId: '' }, { ...valid, requestId: 'x'.repeat(129) },
    { ...valid, requestId: 'x\n' }, { ...valid, requestId: '\u0085' },
    { ...valid, type: 'lower' }, { ...valid, type: 'ADD\n' }, { ...valid, type: 'A'.repeat(65) },
    { ...valid, payload: null }, { ...valid, payload: [] }, { requestId: 'x', type: 'ADD' },
    { ...valid, payload: { callback() { executed = true; } } },
    { ...valid, payload: cyclic }, { ...valid, payload: { value: NaN } },
    { ...valid, payload: { value: Infinity } }, { ...valid, payload: { value: 1n } },
    { ...valid, payload: { value: undefined } }, { ...valid, payload: new Date() },
    { ...valid, payload: { toJSON() { executed = true; return {}; } } },
    { ...valid, module: 'file:///private/plugin.mjs' }, { ...valid, callback: () => {} },
    { ...valid, expectedVersion: -1 }, { ...valid, expectedVersion: 0.5 },
    { ...valid, expectedVersion: '0' }, { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, expectedVersion: undefined },
    { ...valid, get payload() { executed = true; throw new Error('C:/private'); } },
    { ...valid, payload: { get value() { executed = true; return 1; } } },
    { ...valid, payload: { [Symbol('private')]: 1 } },
  ];
  for (const input of cases) {
    const result = await send(input);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.error.code, 'INVALID_ACTION');
    assert.equal(result.committed, false);
    assert.equal(result.confirmations, 0);
    assert.equal(result.snapshot.version, 0);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
  assert.equal(executed, false);
  assert.equal(callCount(), 0);
  assert.equal(sink.events.length, 1);
  assert.equal((await send(valid)).outcome, 'completed'); // malformed inputs never reserved their requestId
});

test('expectedVersion se evalúa en cola; conflicto no ejecuta plugin y no envenena operaciones posteriores', async (t) => {
  const { activate, send, callCount, sink } = await setup(t);
  await activate();
  const [first, stale] = await Promise.all([send(action('first', 1, 0)), send(action('stale', 1, 0))]);
  assert.equal(first.snapshot.version, 1);
  assert.equal(stale.error.code, 'VERSION_CONFLICT');
  assert.equal(stale.outcome, 'rejected');
  assert.equal(stale.committed, false);
  assert.equal(stale.confirmations, 0);
  assert.equal(stale.snapshot.version, 1);
  assert.equal(stale.snapshot.data.count, 1);
  assert.equal(callCount(), 1);
  assert.equal(sink.events.length, 2);
  assert.equal((await send(action('correct', 1, 1))).snapshot.version, 2);
  assert.deepEqual(await send(action('stale', 1, 0)), stale); // version conflicts are recorded, too
  assert.equal((await send(action('stale', 1, 2))).error.code, 'REQUEST_CONFLICT');
  assert.equal(callCount(), 2);
});

test('dos dispatch simultáneos idénticos ejecutan una vez incluso mientras el sink espera', { timeout: 5000 }, async (t) => {
  const { activate, send, callCount, sink } = await setup(t);
  await activate();
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sink.beforeAccept = async (event) => { if (event.type === 'COUNT_CHANGED') { entered(); await gate; } };
  const first = send(action('same', 1, 0));
  await started;
  const second = send(action('same', 1, 0));
  const different = send(action('same', 2, 0));
  release();
  assert.deepEqual(await second, await first);
  assert.equal((await different).error.code, 'REQUEST_CONFLICT');
  assert.equal(callCount(), 1);
  assert.equal(sink.events.length, 2);
});

test('reintento tras avanzar la versión devuelve el resultado original y copias independientes', async (t) => {
  const { manager, prepared, activate, send, callCount } = await setup(t);
  await activate();
  const first = await send(action('original', 1, 0));
  const saved = structuredClone(first);
  first.snapshot.data.count = 999;
  await send(action('later', 3, 1));
  const replay = await send(action('original', 1, 0));
  assert.deepEqual(replay, saved);
  assert.equal(replay.snapshot.version, 1);
  assert.equal(replay.snapshot.data.count, 1);
  replay.snapshot.data.count = 123;
  assert.deepEqual(await send(action('original', 1, 0)), saved);
  assert.equal((await manager.getSnapshot(prepared.matchId)).data.count, 4);
  assert.equal(callCount(), 2);
});

test('mismo requestId con type, payload o expectedVersion distintos produce REQUEST_CONFLICT', async (t) => {
  const { activate, send, callCount } = await setup(t);
  await activate();
  const first = await send(action('one', 1, 0));
  for (const input of [action('one', 2, 0), action('one', 1),
    { requestId: 'one', type: 'SILENT', payload: {}, expectedVersion: 0 }]) {
    const result = await send(input);
    assert.equal(result.error.code, 'REQUEST_CONFLICT');
    assert.equal(result.snapshot.version, 1);
  }
  assert.deepEqual(await send(action('one', 1, 0)), first);
  assert.equal(callCount(), 1);
});

test('equivalencia JSON ordena objetos recursivamente y conserva orden de arrays y tipos de valores', async (t) => {
  const { activate, send, callCount } = await setup(t);
  await activate();
  const first = await send({ requestId: 'logical', type: 'CUSTOM_NOOP', expectedVersion: 0,
    payload: { a: 1, nested: { z: 2, a: 'text' }, list: [{ x: 1, y: 2 }, 3] } });
  const equivalent = { payload: { list: [{ y: 2, x: 1 }, 3], nested: { a: 'text', z: 2 }, a: 1 },
    expectedVersion: 0, type: 'CUSTOM_NOOP', requestId: 'logical' };
  assert.deepEqual(await send(equivalent), first);
  assert.equal(callCount(), 1);
  const differentArray = structuredClone(equivalent);
  differentArray.payload.list.reverse();
  assert.equal((await send(differentArray)).error.code, 'REQUEST_CONFLICT');
  const differentType = structuredClone(equivalent);
  differentType.payload.a = '1';
  assert.equal((await send(differentType)).error.code, 'REQUEST_CONFLICT');
  assert.equal(callCount(), 1);
});

test('fallo externo después de confirmar se guarda; reintento no repite la jugada humana', async (t) => {
  const { activate, send, callCount, sink, probe } = await setup(t);
  await activate();
  const input = { requestId: 'human', type: 'HUMAN_MOVE', payload: {}, expectedVersion: 0 };
  const first = await send(input);
  assert.equal(first.outcome, 'dependency_failed');
  assert.equal(first.committed, true);
  assert.equal(first.confirmations, 1);
  assert.equal(first.snapshot.version, 1);
  assert.deepEqual(first.snapshot.data.moves, ['human']);
  assert.ok(!JSON.stringify(first).includes('private'));
  assert.deepEqual(await send(input), first);
  assert.equal(callCount(), 1);
  probe.setDependency(async () => ({}));
  assert.equal((await send({ requestId: 'ai', type: 'RETRY_AI', payload: {}, expectedVersion: 1 })).snapshot.version, 2);
  assert.deepEqual(await send(input), first);
  assert.equal(callCount(), 2);
  assert.equal(sink.events.filter((event) => event.type === 'MOVE_PLACED').length, 1);
});

test('requestId e historial están aislados por instancia', async (t) => {
  const { manager, prepared, activate, sink, probe } = await setup(t);
  await activate();
  const second = await manager.create('sdk-counter');
  await manager.activate(second.matchId);
  const first = await manager.dispatch(prepared.matchId, action('shared', 1, 0));
  const other = await manager.dispatch(second.matchId, action('shared', 2, 0));
  assert.equal(first.snapshot.data.count, 1);
  assert.equal(other.snapshot.data.count, 2);
  assert.equal(probe.calls.get(prepared.matchId), 1);
  assert.equal(probe.calls.get(second.matchId), 1);
  assert.equal(sink.events.filter((event) => event.type === 'COUNT_CHANGED').length, 2);
});

test('FIFO acotado no renueva por lecturas; una solicitud expulsada puede volver a ejecutarse', async (t) => {
  const { activate, send, callCount } = await setup(t, { requestHistoryLimit: 2 });
  await activate();
  const first = await send(action('oldest'));
  await send(action('second'));
  assert.deepEqual(await send(action('oldest')), first); // hit must not refresh FIFO
  await send(action('third'));
  assert.equal(callCount(), 3);
  const repeated = await send(action('oldest'));
  assert.equal(callCount(), 4);
  assert.equal(repeated.snapshot.version, 4);
  assert.equal(repeated.snapshot.data.count, 4);
});

test('cuota predeterminada es 128; configuración inválida se rechaza', async (t) => {
  const { factory, activate, send, callCount } = await setup(t);
  for (const requestHistoryLimit of [0, 1025, 1.5, '2']) {
    assert.throws(() => new GameInstanceManager(factory, { requestHistoryLimit }), { code: 'INVALID_CONFIGURATION' });
  }
  await activate();
  const noop = (id) => ({ requestId: id, type: 'CUSTOM_NOOP', payload: {} });
  const first = await send(noop('id-0'));
  for (let index = 1; index < 128; index++) await send(noop(`id-${index}`));
  assert.deepEqual(await send(noop('id-0')), first);
  assert.equal(callCount(), 128);
  await send(noop('id-128'));
  await send(noop('id-0'));
  assert.equal(callCount(), 130);
});

test('duplicado concurrente conserva su promesa aunque otros resultados expulsen después el historial', { timeout: 5000 }, async (t) => {
  const { activate, send, callCount, sink } = await setup(t, { requestHistoryLimit: 1 });
  await activate();
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sink.beforeAccept = async (event) => { if (event.type === 'COUNT_CHANGED') { entered(); await gate; } };
  const first = send(action('in-flight'));
  await started;
  const later = send({ requestId: 'later', type: 'CUSTOM_NOOP', payload: {} });
  const duplicate = send(action('in-flight'));
  release();
  const result = await first;
  await later;
  assert.deepEqual(await duplicate, result);
  assert.equal(callCount(), 2);
});

test('dispatch coordina activate, lecturas y otro dispatch sin cambiar la cola por partida', { timeout: 5000 }, async (t) => {
  const { manager, prepared, activate, send, sink } = await setup(t);
  const starting = activate();
  const first = send(action('one', 1, 0));
  assert.equal((await starting).state, 'running');
  assert.equal((await first).snapshot.version, 1);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sink.beforeAccept = async (event) => { if (event.type === 'COUNT_CHANGED') { entered(); await gate; } };
  const second = send(action('two', 1, 1));
  await started;
  let readDone = false;
  const reading = manager.getSnapshot(prepared.matchId).then((snapshot) => { readDone = true; return snapshot; });
  const third = send(action('three', 1, 2));
  const repeatActivation = manager.activate(prepared.matchId);
  assert.equal(readDone, false);
  release();
  assert.equal((await second).snapshot.version, 2);
  const snapshot = await reading;
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.data.count, 2);
  assert.equal((await third).snapshot.version, 3);
  assert.equal((await repeatActivation).version, 3);
});

test('otra partida progresa mientras un dispatch espera; finish espera el dispatch de su propia instancia', { timeout: 5000 }, async (t) => {
  const { manager, prepared, activate, send, sink, probe } = await setup(t);
  await activate();
  const second = await manager.create('sdk-counter');
  await manager.activate(second.matchId);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sink.beforeAccept = async (event) => {
    if (event.type === 'COUNT_CHANGED' && event.matchId === prepared.matchId) { entered(); await gate; }
  };
  const first = send(action('one'));
  await started;
  let finishDone = false;
  const finishing = manager.finish(prepared.matchId).then((snapshot) => { finishDone = true; return snapshot; });
  assert.equal((await manager.dispatch(second.matchId, action('one'))).snapshot.version, 1);
  assert.equal(finishDone, false);
  release();
  const original = await first;
  const closed = await finishing;
  assert.equal(closed.state, 'finished');
  assert.equal(closed.version, 2);
  assert.deepEqual(await send(action('one')), original); // replay has original running snapshot
  assert.equal(probe.calls.get(prepared.matchId), 1);
  assert.deepEqual(sink.events.filter((event) => event.matchId === prepared.matchId).map((event) => event.type),
    ['MATCH_STARTED', 'COUNT_CHANGED', 'MATCH_FINISHED']);
});

test('finishMatch dentro de dispatch cierra sin interbloqueo y permite reintentar el resultado guardado', { timeout: 5000 }, async (t) => {
  const { activate, send, callCount, sink } = await setup(t);
  await activate();
  const input = { requestId: 'close', type: 'CLOSE', payload: {}, expectedVersion: 0 };
  const first = await send(input);
  assert.equal(first.outcome, 'completed');
  assert.equal(first.snapshot.state, 'finished');
  assert.equal(first.snapshot.version, 2);
  assert.deepEqual(await send(input), first);
  assert.equal((await send(action('new'))).error.code, 'INVALID_LIFECYCLE');
  assert.equal(callCount(), 1);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED', 'MATCH_FINISHED']);
});

test('acciones nuevas en prepared, closing o finished se rechazan sin ejecutar el plugin', async (t) => {
  const { manager, prepared, activate, send, sink, callCount } = await setup(t);
  assert.equal((await send(action('before'))).error.code, 'INVALID_LIFECYCLE');
  assert.equal(callCount(), 0);
  await activate();
  assert.equal((await send(action('before'))).outcome, 'completed'); // preflight refusal was not cached
  sink.failType = 'MATCH_FINISHED';
  await assert.rejects(manager.finish(prepared.matchId), { code: 'EVENT_ACCEPTANCE_FAILED' });
  const closing = await send(action('closing'));
  assert.equal(closing.error.code, 'INVALID_LIFECYCLE');
  assert.equal(closing.snapshot.state, 'closing');
  sink.failType = undefined;
  await manager.finish(prepared.matchId);
  const finished = await send(action('finished'));
  assert.equal(finished.error.code, 'INVALID_LIFECYCLE');
  assert.equal(finished.snapshot.state, 'finished');
  assert.equal(callCount(), 1);
});

test('resultado closing se conserva tras reintentar el cierre explícitamente sin volver a ejecutar la acción', async (t) => {
  const { manager, prepared, activate, send, sink, callCount } = await setup(t);
  await activate();
  sink.failType = 'MATCH_FINISHED';
  const input = { requestId: 'close', type: 'CLOSE', payload: {}, expectedVersion: 0 };
  const first = await send(input);
  assert.equal(first.outcome, 'dependency_failed');
  assert.equal(first.committed, true);
  assert.equal(first.error.code, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(first.snapshot.state, 'closing');
  assert.equal(first.snapshot.version, 1);
  assert.deepEqual(await send(input), first);
  sink.failType = undefined;
  assert.equal((await manager.finish(prepared.matchId)).version, 2);
  assert.deepEqual(await send(input), first);
  assert.equal(callCount(), 1);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED', 'MATCH_FINISHED']);
});

test('dispatch reentrante no se une a su propia solicitud ni espera su propia cola', { timeout: 5000 }, async (t) => {
  const { probe, activate, send, callCount } = await setup(t);
  await activate();
  let rejection;
  probe.setDispatchHook(async () => {
    rejection = await send(action('same'));
  });
  const result = await send(action('same'));
  assert.equal(rejection.error.code, 'REENTRANT_OPERATION');
  assert.equal(rejection.committed, false);
  assert.equal(rejection.snapshot.version, 0);
  assert.equal(result.snapshot.version, 1);
  assert.deepEqual(await send(action('same')), result);
  assert.equal(callCount(), 1);
});

test('dispatch desde el sink de activación rechaza reentrancia sin bloquear la cola de ciclo de vida', { timeout: 5000 }, async (t) => {
  const { sink, activate, send, callCount } = await setup(t);
  let nested;
  sink.beforeAccept = async (event) => {
    if (event.type === 'MATCH_STARTED') nested = await send(action('nested'));
  };
  assert.equal((await activate()).state, 'running');
  assert.equal(nested.error.code, 'REENTRANT_OPERATION');
  assert.equal(nested.committed, false);
  assert.equal(callCount(), 0);
  assert.equal((await send(action('nested'))).snapshot.version, 1);
});

test('rechazo previo a confirmar también se memoriza sin filtrar errores internos', async (t) => {
  const { activate, send, callCount } = await setup(t);
  await activate();
  const input = { requestId: 'failure', type: 'FAIL_BEFORE', payload: {} };
  const first = await send(input);
  assert.equal(first.outcome, 'dependency_failed');
  assert.equal(first.committed, false);
  assert.equal(first.snapshot.version, 0);
  assert.ok(!JSON.stringify(first).includes('private'));
  assert.deepEqual(await send(input), first);
  assert.equal(callCount(), 1);
});

test('desconocidos y sesiones anteriores sin celda producen rechazos JSON seguros', async (t) => {
  const { manager, prepared, activate, send } = await setup(t, { legacy: true });
  const missing = await manager.dispatch('../private.mjs', action('x'));
  assert.equal(missing.error.code, 'UNKNOWN_MATCH');
  assert.equal(missing.snapshot, null);
  await activate();
  const unsupported = await send(action('x'));
  assert.equal(unsupported.error.code, 'COORDINATED_STATE_REQUIRED');
  assert.equal(unsupported.snapshot.matchId, prepared.matchId);
  assert.equal(unsupported.snapshot.version, 0);
});

test('resultados profundos válidos se guardan sin fallar después de confirmar por envolver el snapshot', async (t) => {
  const { activate, send, callCount } = await setup(t);
  await activate();
  const input = { requestId: 'deep', type: 'BUILD_DEEP', payload: {} };
  const result = await send(input);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.snapshot.version, 1);
  assert.deepEqual(await send(input), result);
  assert.equal(callCount(), 1);
});
