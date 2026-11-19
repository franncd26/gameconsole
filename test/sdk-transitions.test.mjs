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
const plugin = await readFile(new URL('./fixtures/sdk-transitions/plugin.mjs', import.meta.url), 'utf8');
const SECRET = 'C:/private/sink.mjs: secret';

class AtomicMemorySink {
  events = [];
  staged = [];
  batchFaultAt;
  failType;
  batchCalls = 0;
  beforeAccept = async () => {};
  async accept(event) {
    await this.beforeAccept(event);
    if (event.type === this.failType) throw new Error(SECRET);
    this.events.push(copyJSON(event));
  }
  async acceptBatch(events) {
    this.batchCalls++;
    const pending = [];
    for (const [index, event] of events.entries()) {
      this.staged.push(event.type);
      if (index === this.batchFaultAt) throw new Error(SECRET);
      pending.push(copyJSON(event));
    }
    this.events.push(...pending); // Single local publication, only after complete staging.
  }
}

async function setup(t, { batchMode = 'atomic', coordinated = true, source } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'gameconsole-sdk-transitions-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith('gameconsole-sdk-transitions-'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'counter');
  await cp(fixture, directory, { recursive: true });
  if (coordinated || source) await writeFile(path.join(directory, 'server.mjs'), source ?? plugin);
  const registry = new GameRegistry();
  await registry.register(directory);
  const factory = new GameSessionFactory(new GamePluginLoader(registry, { trustedIds: ['sdk-counter'] }));
  const sink = new AtomicMemorySink();
  if (batchMode === 'broken') sink.acceptBatch = async (events) => { await sink.accept(events[0]); throw new Error(SECRET); };
  const eventSink = batchMode === 'missing' ? { accept: sink.accept.bind(sink) } : sink;
  const manager = new GameInstanceManager(factory, { eventSink });
  const probe = coordinated ? await import(pathToFileURL(registry.get('sdk-counter').paths.server).href) : null;
  const prepared = await manager.create('sdk-counter');
  const activate = () => manager.activate(prepared.matchId);
  const run = (type, payload) => manager.runOperation(prepared.matchId, (session) => session.dispatch({ type, payload }));
  return { factory, sink, manager, probe, prepared, activate, run };
}

test('transición con un evento publica estado/version juntos y snapshots defensivos', async (t) => {
  const { manager, sink, prepared, activate, run, probe } = await setup(t);
  await activate();
  const result = await run('ADD', { amount: 2 });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.committed, true);
  assert.equal(result.confirmations, 1);
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.snapshot.data.count, 2);
  assert.equal(probe.probes.get(prepared.matchId).read().count, 2);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED']);
  assert.equal(sink.events[1].playerId, 'human');
  result.snapshot.data.count = 99;
  const snapshot = await manager.getSnapshot(prepared.matchId);
  assert.equal(snapshot.data.count, 2);
  assert.equal(snapshot.version, 1);
  assert.throws(() => { probe.probes.get(prepared.matchId).read().moves.push('bad'); }, TypeError);
});

test('transición sin eventos confirma versión sin usar el sink', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  sink.beforeAccept = async () => { throw new Error('must not be called'); };
  const result = await run('SILENT');
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.snapshot.data.count, 1);
  assert.equal(result.committed, true);
  assert.equal(sink.events.length, 1);
});

test('acción inválida no muta, publica ni incrementa versión', async (t) => {
  const { manager, prepared, sink, activate, run } = await setup(t);
  await activate();
  const result = await run('ADD', { amount: -1 });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.committed, false);
  assert.equal(result.snapshot.version, 0);
  assert.equal(result.snapshot.data.count, 0);
  assert.equal(sink.events.length, 1);
  const malformed = await manager.runOperation(prepared.matchId, () => ({
    get outcome() { throw new Error(SECRET); },
  }));
  assert.equal(malformed.error.code, 'INVALID_OPERATION_RESULT');
  assert.equal(malformed.snapshot.version, 0);
  assert.ok(!JSON.stringify(malformed).includes('private'));
});

test('validación completa rechaza reservado, playerId, tamaño, JSON y sobres antes de mutar', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  const cases = [
    [{ type: 'MATCH_STARTED', data: {} }, 'RESERVED_EVENT'],
    [{ type: 'MATCH_FINISHED', data: {} }, 'RESERVED_EVENT'],
    [{ type: 'MOVE_PLACED', data: {}, playerId: 'intruder' }, 'INVALID_EVENT_PLAYER'],
    [{ type: 'MOVE_PLACED', data: null }, 'INVALID_EVENT'],
    [{ type: 'bad type', data: {} }, 'INVALID_EVENT'],
    [{ type: 'MOVE_PLACED', data: {}, eventId: 'forged' }, 'INVALID_EVENT'],
    [{ type: 'MOVE_PLACED', data: { text: 'x'.repeat(1024 * 1024) } }, 'EVENT_TOO_LARGE'],
  ];
  for (const [event, code] of cases) {
    const result = await run('PROPOSE', { data: { count: 100 }, events: [event] });
    assert.equal(result.error.code, code);
    assert.equal(result.committed, false);
    assert.equal(result.snapshot.version, 0);
    assert.equal(result.snapshot.data.count, 0);
    assert.equal(sink.events.length, 1);
  }
  const invalid = await run('PROPOSE', { data: { count: undefined }, events: [] });
  assert.equal(invalid.error.code, 'INVALID_TRANSITION');
  const mixed = await run('PROPOSE', { data: { count: 2 }, events: [
    { type: 'MOVE_PLACED', data: {} }, { type: 'MATCH_FINISHED', data: {} },
  ] });
  assert.equal(mixed.error.code, 'RESERVED_EVENT');
  assert.equal(sink.events.length, 1);
  assert.equal(sink.batchCalls, 0);
});

test('candidato, descriptores y recibo son copias: el plugin no cambia lo pendiente o confirmado por referencia', async (t) => {
  const { manager, prepared, probe, sink, activate } = await setup(t);
  await activate();
  const result = await manager.runOperation(prepared.matchId, async () => {
    const proposal = { data: { count: 7 }, events: [{ type: 'VALUE_SET', data: { count: 7 } }] };
    const pending = probe.probes.get(prepared.matchId).context.confirmTransition(proposal);
    proposal.data.count = 999;
    proposal.events[0].data.count = 999;
    const receipt = await pending;
    assert.equal(receipt.version, 1);
    assert.equal(receipt.snapshot.data.count, 7);
    receipt.snapshot.data.count = 123;
  });
  assert.equal(result.snapshot.data.count, 7);
  assert.equal(sink.events[1].data.count, 7);
});

test('rechazo de un evento por el sink deja estado y versión intactos y permite otro intento', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  sink.failType = 'COUNT_CHANGED';
  const failed = await run('ADD', { amount: 1 });
  assert.equal(failed.error.code, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(failed.outcome, 'rejected');
  assert.equal(failed.snapshot.data.count, 0);
  assert.equal(failed.snapshot.version, 0);
  assert.ok(!JSON.stringify(failed).includes('private'));
  assert.equal(sink.events.length, 1);
  sink.failType = undefined;
  assert.equal((await run('ADD', { amount: 1 })).snapshot.version, 1);
});

test('varios eventos confirman un lote completo y una sola versión', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  const result = await run('BATCH');
  assert.equal(result.snapshot.data.count, 2);
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.confirmations, 1);
  assert.equal(sink.batchCalls, 1);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED', 'SECOND_EVENT']);
});

test('fallo intermedio al preparar el lote no acepta prefijo ni confirma estado', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  sink.batchFaultAt = 1;
  const failed = await run('BATCH');
  assert.deepEqual(sink.staged, ['COUNT_CHANGED', 'SECOND_EVENT']);
  assert.equal(failed.error.code, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(failed.committed, false);
  assert.equal(failed.snapshot.version, 0);
  assert.equal(failed.snapshot.data.count, 0);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED']);
});

test('sink de 2B.1 sin acceptBatch rechaza varios eventos antes de enviar cualquiera', async (t) => {
  const { sink, activate, run } = await setup(t, { batchMode: 'missing' });
  await activate();
  const failed = await run('BATCH');
  assert.equal(failed.error.code, 'BATCH_SINK_REQUIRED');
  assert.equal(failed.snapshot.version, 0);
  assert.equal(sink.events.length, 1);
  assert.equal((await run('ADD', { amount: 1 })).snapshot.version, 1);
});

test('contraejemplo: un sink que viola acceptBatch puede dejar prefijos; el host no puede deshacerlos', async (t) => {
  const { sink, activate, run } = await setup(t, { batchMode: 'broken' });
  await activate();
  const failed = await run('BATCH');
  assert.equal(failed.error.code, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(failed.snapshot.version, 0);
  assert.equal(failed.snapshot.data.count, 0);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED']);
  // This is deliberately a broken transport contract, not an atomicity guarantee.
});

test('varias transiciones en una operación conservan el prefijo ya confirmado ante un fallo', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  sink.failType = 'SECOND_EVENT';
  const result = await run('TWO_TRANSITIONS');
  assert.equal(result.outcome, 'dependency_failed');
  assert.equal(result.committed, true);
  assert.equal(result.confirmations, 1);
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.snapshot.data.count, 1);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED']);
});

test('mock de Gato conserva jugada humana y permite recuperar IA sin repetirla', async (t) => {
  const { sink, activate, run, probe } = await setup(t);
  await activate();
  const partial = await run('HUMAN_MOVE');
  assert.equal(partial.outcome, 'dependency_failed');
  assert.equal(partial.committed, true);
  assert.equal(partial.snapshot.version, 1);
  assert.deepEqual(partial.snapshot.data.moves, ['human']);
  assert.equal(partial.snapshot.data.awaitingAI, true);
  assert.ok(!JSON.stringify(partial).includes('private'));
  assert.equal((await run('HUMAN_MOVE')).outcome, 'rejected');
  probe.setDependency(async () => ({ result: 'mock' }));
  const recovered = await run('RETRY_AI');
  assert.equal(recovered.snapshot.version, 2);
  assert.deepEqual(recovered.snapshot.data.moves, ['human', 'ai']);
  assert.equal(recovered.snapshot.data.awaitingAI, false);
  assert.equal(sink.events.filter((event) => event.type === 'MOVE_PLACED').length, 1);
  assert.equal(sink.events.filter((event) => event.type === 'AI_DECISION').length, 1);
});

test('misma partida ordena confirmaciones; otra progresa mientras el primer sink espera', { timeout: 5000 }, async (t) => {
  const { manager, prepared, probe, sink, activate } = await setup(t);
  await activate();
  const second = await manager.create('sdk-counter');
  await manager.activate(second.matchId);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sink.beforeAccept = async (event) => {
    if (event.matchId === prepared.matchId && event.type === 'COUNT_CHANGED') { entered(); await gate; }
  };
  const runFor = (id) => manager.runOperation(id, (session) => session.dispatch({ type: 'ADD', payload: { amount: 1 } }));
  const first = runFor(prepared.matchId);
  await started;
  assert.equal(probe.probes.get(prepared.matchId).read().count, 0);
  let readDone = false;
  const reading = manager.getSnapshot(prepared.matchId).then((value) => { readDone = true; return value; });
  const queued = runFor(prepared.matchId);
  assert.equal((await runFor(second.matchId)).snapshot.version, 1);
  assert.equal(readDone, false);
  release();
  assert.equal((await first).snapshot.version, 1);
  const snapshot = await reading;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.data.count, 1);
  const last = await queued;
  assert.equal(last.snapshot.version, 2);
  assert.equal(last.snapshot.data.count, 2);
  assert.equal((await manager.getSnapshot(second.matchId)).data.count, 1);
});

test('cierre solicitado y esperado dentro de acción no bloquea; nunca hay eventos después del cierre', { timeout: 5000 }, async (t) => {
  const { manager, prepared, sink, activate, run, probe } = await setup(t);
  await activate();
  const result = await run('CLOSE');
  assert.equal(result.snapshot.state, 'finished');
  assert.equal(result.snapshot.version, 2); // one domain confirmation plus lifecycle close
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED', 'MATCH_FINISHED']);
  await assert.rejects(run('ADD', { amount: 1 }), { code: 'INVALID_LIFECYCLE' });
  assert.throws(() => probe.probes.get(prepared.matchId).context.confirmTransition({ data: {}, events: [] }), { code: 'TRANSITIONS_UNAVAILABLE' });
  await manager.finish(prepared.matchId);
  assert.equal(sink.events.length, 3);
});

test('confirmar después de solicitar cierre se rechaza antes del sink y el cierre no se duplica', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  const result = await run('CLOSE_THEN_CONFIRM');
  assert.equal(result.error.code, 'CLOSE_REQUESTED');
  assert.equal(result.committed, false);
  assert.equal(result.snapshot.state, 'finished');
  assert.equal(result.snapshot.version, 1);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'MATCH_FINISHED']);
});

test('rechazo de cierre solicitado durante operación conserva confirmaciones y política closing de 2B.1', async (t) => {
  const { manager, prepared, sink, activate, run } = await setup(t);
  await activate();
  sink.failType = 'MATCH_FINISHED';
  const result = await run('CLOSE');
  assert.equal(result.committed, true);
  assert.equal(result.error.code, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(result.snapshot.state, 'closing');
  assert.equal(result.snapshot.version, 1);
  assert.equal(result.snapshot.data.count, 1);
  await assert.rejects(run('SILENT'), { code: 'INVALID_LIFECYCLE' });
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED']);
  sink.failType = undefined;
  const closed = await manager.finish(prepared.matchId);
  assert.equal(closed.version, 2);
  assert.equal(closed.state, 'finished');
  await manager.finish(prepared.matchId);
  assert.deepEqual(sink.events.map((event) => event.type), ['MATCH_STARTED', 'COUNT_CHANGED', 'MATCH_FINISHED']);
});

test('errores de confirmación capturados y promesas sin await no ocultan fallos o versiones', async (t) => {
  const { sink, activate, run } = await setup(t);
  await activate();
  const caught = await run('CAUGHT_FAILURE');
  assert.equal(caught.error.code, 'RESERVED_EVENT');
  assert.equal(caught.snapshot.version, 0);
  assert.equal(sink.events.length, 1);
  const unawaited = await run('UNAWAITED');
  assert.equal(unawaited.snapshot.version, 1);
  assert.equal(unawaited.snapshot.data.count, 1);
  sink.failType = 'COUNT_CHANGED';
  const failed = await run('UNAWAITED');
  assert.equal(failed.error.code, 'EVENT_ACCEPTANCE_FAILED');
  assert.equal(failed.snapshot.version, 1);
});

test('esperar la cola recursivamente se rechaza en vez de interbloquear', { timeout: 5000 }, async (t) => {
  const { manager, prepared, activate } = await setup(t);
  await activate();
  const result = await manager.runOperation(prepared.matchId, async (session) => {
    await assert.rejects(manager.finish(prepared.matchId), { code: 'REENTRANT_OPERATION' });
    await assert.rejects(manager.getSnapshot(prepared.matchId), { code: 'REENTRANT_OPERATION' });
    return session.dispatch({ type: 'SILENT' });
  });
  assert.equal(result.snapshot.version, 1);
});

test('operaciones fuera de running y contextos asincrónicos vencidos no pueden publicar', { timeout: 5000 }, async (t) => {
  const { manager, prepared, activate, sink, probe } = await setup(t);
  const context = probe.probes.get(prepared.matchId).context;
  await assert.rejects(manager.runOperation(prepared.matchId, () => {}), { code: 'INVALID_LIFECYCLE' });
  assert.throws(() => context.confirmTransition({ data: {}, events: [] }), { code: 'TRANSITIONS_UNAVAILABLE' });
  let activationEntered, activationRelease;
  const entered = new Promise((resolve) => { activationEntered = resolve; });
  const gateActivation = new Promise((resolve) => { activationRelease = resolve; });
  sink.beforeAccept = async () => { activationEntered(); await gateActivation; };
  const activating = activate();
  await entered;
  assert.throws(() => context.confirmTransition({ data: {}, events: [] }), { code: 'TRANSITIONS_UNAVAILABLE' });
  activationRelease();
  await activating;
  sink.beforeAccept = async () => {};
  let release, late;
  const gate = new Promise((resolve) => { release = resolve; });
  await manager.runOperation(prepared.matchId, () => {
    late = gate.then(() => context.confirmTransition({ data: { count: 9 }, events: [] }));
  });
  release();
  await assert.rejects(late, { code: 'TRANSITIONS_UNAVAILABLE' });
  assert.equal((await manager.getSnapshot(prepared.matchId)).version, 0);
  assert.equal(sink.events.length, 1);
  sink.failType = 'MATCH_FINISHED';
  await assert.rejects(manager.finish(prepared.matchId), { code: 'EVENT_ACCEPTANCE_FAILED' });
  assert.throws(() => context.confirmTransition({ data: {}, events: [] }), { code: 'TRANSITIONS_UNAVAILABLE' });
  await assert.rejects(manager.runOperation(prepared.matchId, () => {}), { code: 'INVALID_LIFECYCLE' });
  assert.equal(sink.events.length, 1);
});

test('confirmar durante preparación invalida la sesión aunque el plugin capture el error', async (t) => {
  const source = plugin.replace('const state = context.createState',
    'try { context.confirmTransition({data:{},events:[]}); } catch {} const state = context.createState');
  await assert.rejects(setup(t, { source }), { code: 'EVENT_DURING_PREPARATION' });
});

test('sesiones sin celda conservan 2A/2B.1 y rechazan solo el coordinador nuevo', async (t) => {
  const { manager, prepared, activate, sink } = await setup(t, { coordinated: false });
  await activate();
  await assert.rejects(manager.runOperation(prepared.matchId, () => {}), { code: 'COORDINATED_STATE_REQUIRED' });
  assert.equal((await manager.getSnapshot(prepared.matchId)).version, 0);
  await manager.finish(prepared.matchId);
  assert.equal(sink.events.length, 2);
});
