import test from 'node:test';
import assert from 'node:assert/strict';
import { EventOutbox } from '../server/outbox.mjs';
import { OutboxEventSink } from '../server/sdk/outbox-event-sink.mjs';
import { GameEventAdapter } from '../server/sdk/event-adapter.mjs';
import { createFixtureTransport } from './helpers/sdk-transport.mjs';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const lap = (requestId, durationMs = 1234) => ({ requestId, type: 'COMPLETE_LAP', payload: { durationMs } });

class Receiver {
  events = [];
  attempts = [];
  inspections = [];
  beforePost = async () => {};
  watchers = [];
  fetch = async (url, options) => {
    if (options?.method !== 'POST') {
      this.inspections.push(url);
      const [gameId, matchId] = new URL(url).pathname.split('/').slice(-2).map(decodeURIComponent);
      return { ok: true, status: 200, json: async () => ({
        eventIds: this.events.filter((event) => event.gameId === gameId && event.matchId === matchId).map((event) => event.eventId),
      }) };
    }
    const event = JSON.parse(options.body);
    this.attempts.push(event);
    const intercepted = await this.beforePost(event);
    if (intercepted) return intercepted;
    const prior = this.events.filter((item) => item.gameId === event.gameId && item.matchId === event.matchId);
    if (prior.some((item) => item.eventId === event.eventId) || prior.at(-1)?.type === 'MATCH_FINISHED'
      || (prior.length === 0 && event.type !== 'MATCH_STARTED') || (prior.length > 0 && event.type === 'MATCH_STARTED')) {
      return { ok: false, status: 409 };
    }
    this.events.push(event);
    this.watchers.forEach((notify) => notify());
    return { ok: true, status: 200 };
  };
  waitForCount(matchId, count) {
    return new Promise((resolve) => {
      const notify = () => { if (this.events.filter((event) => event.matchId === matchId).length >= count) resolve(); };
      this.watchers.push(notify);
      notify();
    });
  }
}

async function setup(t, receiver = new Receiver()) {
  const app = await createFixtureTransport({ fetcher: receiver.fetch, retryMs: 1 });
  t.after(() => app.outbox.stop());
  return { ...app, receiver };
}

function batchEvents() {
  const adapter = new GameEventAdapter({ gameId: 'fixture', gameVersion: '1.0.0', matchId: 'batch', players: [{ id: 'p1', role: 'human' }] });
  return structuredClone([adapter.createMatchStarted({}), adapter.createDomainEvent({ type: 'LAP_COMPLETED', playerId: 'p1', data: { lap: 1, durationMs: 1000 } })]);
}

test('ensamblador SDK real entrega inicio, dominio y cierre ordenados y sin duplicados', async (t) => {
  const { manager, outbox, receiver } = await setup(t);
  const prepared = await manager.create('racing');
  assert.equal(prepared.state, 'prepared');
  assert.equal(receiver.events.length, 0);
  assert.equal((await manager.activate(prepared.matchId)).state, 'running');
  const result = await manager.dispatch(prepared.matchId, lap('lap'));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.snapshot.version, 1);
  assert.deepEqual((await manager.getSnapshot(prepared.matchId)).data, { laps: 1, totalDurationMs: 1234 });
  assert.deepEqual(await manager.dispatch(prepared.matchId, lap('lap')), result);
  const closed = await manager.finish(prepared.matchId);
  assert.equal(closed.version, 2);
  assert.equal(closed.state, 'finished');
  await manager.finish(prepared.matchId);
  await outbox.flush(1000);
  assert.deepEqual(receiver.events.map((event) => event.type), ['MATCH_STARTED', 'LAP_COMPLETED', 'MATCH_FINISHED']);
  assert.equal(new Set(receiver.events.map((event) => event.eventId)).size, 3);
  assert.ok(receiver.events.every((event) => event.gameId === 'racing' && event.matchId === prepared.matchId));
  assert.deepEqual(receiver.events[0].data.players, ['p1']);
  assert.deepEqual(outbox.status(prepared.matchId), { pending: 0, delivered: 3, error: null });
});

test('lote completo se publica antes del primer fetch; input posterior no altera la cola', async (t) => {
  const gate = deferred();
  let outbox;
  const observedQueues = [];
  const received = [];
  outbox = new EventOutbox('http://transport.test', { fetcher: async (_url, options) => {
    observedQueues.push(outbox.streams.get('batch').queue.map((event) => event.eventId));
    await gate.promise;
    received.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  } });
  t.after(() => outbox.stop());
  const events = batchEvents();
  const expected = structuredClone(events);
  assert.equal(outbox.enqueueBatch(events), undefined);
  assert.deepEqual(observedQueues[0], expected.map((event) => event.eventId));
  assert.deepEqual(outbox.status('batch'), { pending: 2, delivered: 0, error: null });
  events[1].data.durationMs = 999;
  events[1].eventId = 'mutated';
  gate.resolve();
  await outbox.flush(1000);
  assert.deepEqual(received, expected);
  assert.equal(outbox.status('batch').delivered, 2);
});

test('un lote inválido no inserta ni envía un prefijo, incluso junto a una cola existente', async (t) => {
  const gate = deferred();
  let fetches = 0;
  const outbox = new EventOutbox('http://transport.test', { fetcher: async () => {
    fetches++;
    await gate.promise;
    return { ok: true, status: 200 };
  } });
  t.after(() => outbox.stop());
  const valid = batchEvents();
  let invoked = false;
  const accessor = [valid[0]];
  Object.defineProperty(accessor, '1', { enumerable: true, get() { invoked = true; return valid[1]; } });
  const sparse = [valid[0]]; sparse.length = 2;
  const invalid = [[], Array.from({ length: 33 }, (_, index) => ({ ...valid[1], eventId: `id-${index}` })), sparse, accessor,
    [valid[0], { ...valid[1], schemaVersion: 2 }],
    [valid[0], { ...valid[1], matchId: 'other' }], [valid[0], { ...valid[1], gameId: 'other' }],
    [valid[0], { ...valid[1], eventId: valid[0].eventId }], [valid[0], { ...valid[1], data: null }],
    [valid[0], { ...valid[1], timestamp: '2026-02-30T00:00:00Z' }],
    [valid[0], { ...valid[1], playerId: null }], [valid[0], { ...valid[1], data: { bad() {} } }],
    [valid[0], { ...valid[1], data: { text: 'x'.repeat(1024 * 1024) } }],
    [valid[0], { ...valid[1], get data() { invoked = true; return {}; } }],
  ];
  for (const batch of invalid) {
    assert.throws(() => outbox.enqueueBatch(batch), { code: 'INVALID_EVENT_BATCH' });
    assert.equal(outbox.streams.size, 0);
    assert.equal(fetches, 0);
  }
  outbox.enqueueBatch([valid[0]]);
  const originalQueue = outbox.streams.get('batch').queue;
  assert.throws(() => outbox.enqueueBatch(invalid[4]), { code: 'INVALID_EVENT_BATCH' });
  assert.equal(outbox.streams.get('batch').queue, originalQueue);
  assert.equal(outbox.status('batch').pending, 1);
  assert.equal(fetches, 1);
  assert.equal(invoked, false);
  gate.resolve();
  await outbox.flush(1000);
});

test('OutboxEventSink valida aceptación individual y rechaza tras stop sin retener nada nuevo', () => {
  let fetches = 0;
  const outbox = new EventOutbox('http://transport.test', { fetcher: async () => { fetches++; return { ok: true, status: 200 }; } });
  const sink = new OutboxEventSink(outbox);
  assert.throws(() => new OutboxEventSink({ enqueueBatch() {} }), { code: 'INVALID_CONFIGURATION' });
  assert.throws(() => sink.accept({ matchId: 'incomplete' }), { code: 'INVALID_EVENT_BATCH' });
  assert.equal(outbox.streams.size, 0);
  assert.equal(fetches, 0);
  outbox.stop();
  assert.throws(() => sink.acceptBatch(batchEvents()), { code: 'OUTBOX_STOPPED' });
  assert.throws(() => sink.accept(batchEvents()[0]), { code: 'OUTBOX_STOPPED' });
  assert.equal(outbox.streams.size, 0);
  outbox.enqueue({ matchId: 'legacy', eventId: 'legacy' }); // Existing enqueue still buffers after stop.
  assert.equal(outbox.status('legacy').pending, 1);
  assert.equal(fetches, 0);
});

test('SDK confirma un lote de dos eventos sin esperar entrega; Outbox distingue pendientes y entregados', async (t) => {
  const { manager, outbox, receiver } = await setup(t);
  const gate = deferred();
  receiver.beforePost = async () => { await gate.promise; };
  const prepared = await manager.create('racing');
  await manager.activate(prepared.matchId);
  const result = await manager.dispatch(prepared.matchId, {
    requestId: 'two-laps', type: 'COMPLETE_TWO_LAPS', payload: { durations: [1000, 2000] }, expectedVersion: 0,
  });
  assert.equal(result.committed, true);
  assert.equal(result.confirmations, 1);
  assert.equal(result.snapshot.version, 1);
  assert.deepEqual(result.snapshot.data, { laps: 2, totalDurationMs: 3000 });
  await manager.finish(prepared.matchId);
  assert.equal(receiver.events.length, 0);
  assert.deepEqual(outbox.status(prepared.matchId), { pending: 4, delivered: 0, error: null });
  gate.resolve();
  await outbox.flush(1000);
  assert.deepEqual(receiver.events.map((event) => event.type), ['MATCH_STARTED', 'LAP_COMPLETED', 'LAP_COMPLETED', 'MATCH_FINISHED']);
  assert.deepEqual(receiver.events.filter((event) => event.type === 'LAP_COMPLETED').map((event) => event.data.lap), [1, 2]);
  assert.equal(outbox.status(prepared.matchId).delivered, 4);
  assert.equal(new Set(receiver.events.map((event) => event.eventId)).size, 4);
});

test('red transitoria rechazada antes de recibir reintenta la misma identidad conservando orden', async (t) => {
  const receiver = new Receiver();
  let failed = false;
  receiver.beforePost = async () => { if (!failed) { failed = true; throw new Error('network'); } };
  const { manager, outbox } = await setup(t, receiver);
  const prepared = await manager.create('racing');
  await manager.activate(prepared.matchId);
  await manager.dispatch(prepared.matchId, lap('one'));
  await manager.finish(prepared.matchId);
  await outbox.flush(1000);
  assert.equal(receiver.attempts[0].eventId, receiver.attempts[1].eventId);
  assert.deepEqual(receiver.events.map((event) => event.type), ['MATCH_STARTED', 'LAP_COMPLETED', 'MATCH_FINISHED']);
  assert.equal(outbox.status(prepared.matchId).delivered, 3);
});

test('409 después de perder una respuesta solo confirma entrega si el receptor contiene el mismo eventId', async (t) => {
  const receiver = new Receiver();
  let lost = false;
  const originalFetch = receiver.fetch;
  receiver.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (options?.method === 'POST' && !lost) { lost = true; throw new Error('response lost after acceptance'); }
    return response;
  };
  const { manager, outbox } = await setup(t, receiver);
  const prepared = await manager.create('racing');
  await manager.activate(prepared.matchId);
  await manager.dispatch(prepared.matchId, lap('one'));
  await manager.finish(prepared.matchId);
  await outbox.flush(1000);
  assert.ok(receiver.inspections.length >= 1);
  assert.equal(receiver.attempts[0].eventId, receiver.attempts[1].eventId);
  assert.equal(receiver.events.length, 3);
  assert.equal(new Set(receiver.events.map((event) => event.eventId)).size, 3);
  assert.equal(outbox.status(prepared.matchId).delivered, 3);
});

test('409 con un eventId diferente sigue pendiente y no se cuenta como entregado', async (t) => {
  const observed = deferred();
  let conflict = true;
  let posts = 0;
  const app = await createFixtureTransport({ retryMs: 1, fetcher: async (_url, options) => {
    if (options?.method === 'POST') { posts++; return { ok: !conflict, status: conflict ? 409 : 200 }; }
    observed.resolve();
    return { ok: true, json: async () => ({ eventIds: ['someone-else'] }) };
  } });
  t.after(() => app.outbox.stop());
  const prepared = await app.manager.create('racing');
  await app.manager.activate(prepared.matchId);
  await observed.promise;
  await nextTurn();
  assert.equal(app.outbox.status(prepared.matchId).delivered, 0);
  assert.equal(app.outbox.status(prepared.matchId).pending, 1);
  assert.match(app.outbox.status(prepared.matchId).error, /Conflicto/);
  conflict = false;
  await app.outbox.flush(1000);
  assert.ok(posts >= 2);
  assert.equal(app.outbox.status(prepared.matchId).delivered, 1);
});

test('una partida bloqueada no retiene otra; dos instancias concurrentes conservan sus identidades', { timeout: 5000 }, async (t) => {
  const { manager, outbox, receiver } = await setup(t);
  const first = await manager.create('racing');
  const second = await manager.create('racing');
  assert.notEqual(first.matchId, second.matchId);
  const gate = deferred();
  receiver.beforePost = async (event) => { if (event.matchId === first.matchId) await gate.promise; };
  await Promise.all([manager.activate(first.matchId), manager.activate(second.matchId)]);
  await Promise.all([manager.dispatch(first.matchId, lap('same')), manager.dispatch(second.matchId, lap('same', 2000))]);
  await manager.finish(second.matchId);
  await receiver.waitForCount(second.matchId, 3);
  await nextTurn();
  assert.equal(outbox.status(first.matchId).delivered, 0);
  assert.equal(outbox.status(first.matchId).pending, 2);
  assert.equal(outbox.status(second.matchId).delivered, 3);
  assert.equal((await manager.getSnapshot(first.matchId)).data.totalDurationMs, 1234);
  assert.equal((await manager.getSnapshot(second.matchId)).data.totalDurationMs, 2000);
  gate.resolve();
  await manager.finish(first.matchId);
  await outbox.flush(1000);
  for (const { matchId } of [first, second]) {
    assert.deepEqual(receiver.events.filter((event) => event.matchId === matchId).map((event) => event.type),
      ['MATCH_STARTED', 'LAP_COMPLETED', 'MATCH_FINISHED']);
  }
});
