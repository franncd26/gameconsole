import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, shutdownApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';

const SECRET = 'C:/private/plugin.mjs: confidential shutdown';
const source = `
import base from './base.mjs';
export const hooks = new Map();
export const cleanups = new Map();
export default {
  initializationContract: base.initializationContract,
  createSession(context, options) {
    const prepared = base.createSession(context, options);
    const finish = prepared.session.finish;
    prepared.session.finish = async (request) => {
      cleanups.set(context.matchId, (cleanups.get(context.matchId) ?? 0) + 1);
      await hooks.get(context.matchId)?.();
      return finish(request);
    };
    return prepared;
  }
};`;

function gate() {
  let release, enter;
  const ready = new Promise((r) => { enter = r; });
  const wait = new Promise((r) => { release = r; });
  return { ready, release, async block() { enter(); await wait; } };
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'racing');
  await cp(new URL('./fixtures/sdk-transport/racing/', import.meta.url), dir, { recursive: true });
  await copyFile(path.join(dir, 'server.mjs'), path.join(dir, 'base.mjs'));
  await writeFile(path.join(dir, 'server.mjs'), source);
  const events = [];
  const transport = { beforeAccept: async () => {} };
  const sdk = await prepareSDK({ pluginsDirectory: root, trustedIds: ['racing'] });
  const app = createApp({ sdk, statsURL: 'http://go.test', statsFetcher: async (_url, init) => {
    const event = JSON.parse(init.body);
    await transport.beforeAccept(event);
    events.push(event);
    return new Response('{}', { status: 201 });
  } });
  t.after(() => app.outbox.stop());
  // Match the loader's realpath URL, including Windows path casing, to share test hooks.
  const instrumentation = await import(pathToFileURL(await realpath(path.join(dir, 'server.mjs'))).href);
  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const s = await app.sdk.manager.create('racing');
    sessions.push(await app.sdk.manager.activate(s.matchId));
  }
  await app.outbox.flush(1000);
  return { app, events, sessions, transport, ...instrumentation };
}
function assertNoDuplicates(events, sessions) {
  assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
  for (const s of sessions) {
    assert.deepEqual(events.filter((e) => e.matchId === s.matchId).map((e) => e.type), ['MATCH_STARTED', 'MATCH_FINISHED']);
  }
}

test('three SDK sessions shut down, flush, and retain idempotent MATCH_FINISHED', async (t) => {
  const { app, events, sessions, cleanups } = await setup(t);
  const report = await shutdownApp(app);
  assert.deepEqual(report, { closeFailures: [], delivery: { status: 'flushed' } });
  assert.equal(app.outbox.stopped, true);
  assert.deepEqual((await app.sdk.manager.list()).map((s) => s.state), ['finished', 'finished', 'finished']);
  assertNoDuplicates(events, sessions);
  await app.sdk.shutdown();
  assertNoDuplicates(events, sessions);
  assert.deepEqual([...cleanups.values()], [1, 1, 1]);
});

test('SDK failure is aggregated only after both slower sibling closes settle; accepted close survives cleanup failure', async (t) => {
  const { app, events, sessions, hooks, cleanups } = await setup(t);
  const [bad, slowA, slowB] = sessions;
  const a = gate(), b = gate();
  t.after(() => { a.release(); b.release(); });
  hooks.set(bad.matchId, () => { throw new Error(SECRET); });
  hooks.set(slowA.matchId, () => a.block());
  hooks.set(slowB.matchId, () => b.block());
  let settled = false;
  const shutdown = app.sdk.shutdown().then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
  await Promise.all([a.ready, b.ready]);
  const local = await app.sdk.manager.getSnapshot(bad.matchId);
  assert.equal(local.state, 'finished', 'cleanup failure must not undo a locally accepted close');
  assert.equal(local.version, 1);
  assert.equal(settled, false, 'must wait for both other cleanups despite first rejection');
  a.release();
  await app.sdk.manager.getSnapshot(slowA.matchId);
  assert.equal(settled, false, 'must still wait for the third close');
  b.release();
  const error = await shutdown;
  assert.equal(error.code, 'SDK_SHUTDOWN_FAILED');
  assert.deepEqual(error.failures, [{ matchId: bad.matchId, code: 'CLEANUP_FAILED' }]);
  assert.ok(!/private|confidential|plugin\.mjs/.test(error.message + JSON.stringify(error.failures)));
  await app.outbox.flush(1000);
  assertNoDuplicates(events, sessions);
  await app.sdk.shutdown();
  assert.deepEqual([...cleanups.values()], [1, 1, 1]);
  assertNoDuplicates(events, sessions);
});

test('server waits for every close and flushes actual pending Outbox events despite cleanup rejection, before stopping', async (t) => {
  const { app, events, sessions, hooks, transport } = await setup(t);
  const deliveryGate = gate(), cleanupGate = gate();
  t.after(() => { deliveryGate.release(); cleanupGate.release(); });
  hooks.set(sessions[0].matchId, () => { throw new Error(SECRET); });
  hooks.set(sessions[2].matchId, () => cleanupGate.block());
  transport.beforeAccept = (event) => event.type === 'MATCH_FINISHED' ? deliveryGate.block() : undefined;
  const flush = app.outbox.flush.bind(app.outbox);
  const order = [];
  app.outbox.flush = async (timeout) => {
    order.push('flush');
    assert.equal(timeout, 5000);
    assert.equal(app.outbox.stopped, false);
    assert.deepEqual((await app.sdk.manager.list()).map((s) => s.state), ['finished', 'finished', 'finished']);
    assert.equal(sessions.reduce((n, s) => n + app.outbox.status(s.matchId).pending, 0), 3);
    deliveryGate.release();
    await flush(1000);
    order.push('delivered');
  };
  const stop = app.outbox.stop.bind(app.outbox);
  app.outbox.stop = () => { order.push('stop'); stop(); };
  const shutdown = shutdownApp(app);
  await cleanupGate.ready; await deliveryGate.ready;
  assert.deepEqual(order, [], 'flush must wait for the last unfinished cleanup');
  cleanupGate.release();
  const report = await shutdown;
  assert.deepEqual(report.closeFailures, [{ source: 'sdk', code: 'CLEANUP_FAILED' }]);
  assert.deepEqual(report.delivery, { status: 'flushed' });
  assert.deepEqual(order, ['flush', 'delivered', 'stop']);
  assertNoDuplicates(events, sessions);
});

test('local MATCH_FINISHED rejection is distinct from cleanup failure; retry accepts the retained event only once', async (t) => {
  const { app, events, sessions } = await setup(t);
  const original = app.outbox.enqueueBatch.bind(app.outbox);
  let rejectedEventId;
  app.outbox.enqueueBatch = (batch) => {
    if (batch[0].matchId === sessions[0].matchId && batch[0].type === 'MATCH_FINISHED') {
      rejectedEventId = batch[0].eventId;
      throw new Error(SECRET);
    }
    return original(batch);
  };
  await assert.rejects(app.sdk.shutdown(), (error) => {
    assert.equal(error.code, 'SDK_SHUTDOWN_FAILED');
    assert.deepEqual(error.failures, [{ matchId: sessions[0].matchId, code: 'EVENT_ACCEPTANCE_FAILED' }]);
    return true;
  });
  assert.equal((await app.sdk.manager.getSnapshot(sessions[0].matchId)).state, 'closing');
  assert.equal(events.some((e) => e.eventId === rejectedEventId), false);
  app.outbox.enqueueBatch = original;
  await app.sdk.shutdown();
  await app.outbox.flush(1000);
  assert.equal(events.filter((e) => e.eventId === rejectedEventId).length, 1);
  assertNoDuplicates(events, sessions);
});

test('flush failure is reported separately after all closes, never claims delivery, and still stops afterward', async (t) => {
  const { app, sessions, hooks, transport } = await setup(t);
  const g = gate(); t.after(g.release);
  transport.beforeAccept = () => g.block();
  hooks.set(sessions[0].matchId, () => { throw new Error(SECRET); });
  let flushCalls = 0;
  const flush = app.outbox.flush.bind(app.outbox);
  app.outbox.flush = async (timeout) => {
    flushCalls++;
    assert.equal(timeout, 5000);
    assert.equal(app.outbox.stopped, false);
    assert.deepEqual((await app.sdk.manager.list()).map((s) => s.state), ['finished', 'finished', 'finished']);
    // Exercise the actual Outbox timeout, with a short test budget and blocked fake delivery.
    await flush(0);
  };
  const report = await shutdownApp(app);
  assert.equal(flushCalls, 1);
  assert.deepEqual(report.closeFailures, [{ source: 'sdk', code: 'CLEANUP_FAILED' }]);
  assert.deepEqual(report.delivery, { status: 'failed', code: 'OUTBOX_FLUSH_FAILED' });
  assert.ok(sessions.some((s) => app.outbox.status(s.matchId).pending > 0));
  assert.ok(!/private|confidential/.test(JSON.stringify(report)));
  assert.equal(app.outbox.stopped, true);
  g.release();
});

test('server flush still runs after local close acceptance fails; flushed prefix does not mean every match closed', async (t) => {
  const { app, events, sessions } = await setup(t);
  const enqueueBatch = app.outbox.enqueueBatch.bind(app.outbox);
  app.outbox.enqueueBatch = (batch) => {
    if (batch[0].matchId === sessions[0].matchId && batch[0].type === 'MATCH_FINISHED') throw new Error(SECRET);
    return enqueueBatch(batch);
  };
  const report = await shutdownApp(app);
  assert.deepEqual(report.closeFailures, [{ source: 'sdk', code: 'EVENT_ACCEPTANCE_FAILED' }]);
  assert.deepEqual(report.delivery, { status: 'flushed' }, 'only events that were accepted locally can be flushed');
  assert.equal((await app.sdk.manager.getSnapshot(sessions[0].matchId)).state, 'closing');
  assert.equal(events.filter((e) => e.matchId === sessions[0].matchId && e.type === 'MATCH_FINISHED').length, 0);
  for (const s of sessions.slice(1)) {
    assert.equal(events.filter((e) => e.matchId === s.matchId && e.type === 'MATCH_FINISHED').length, 1);
  }
  assert.equal(app.outbox.stopped, true);
});

test('historical closes keep exclusive/finish contract and share flush with SDK even on synchronous failure', async () => {
  const order = [], g = gate();
  const app = { matches: new Map([
    ['bad', { exclusive() { order.push('bad'); throw new Error(SECRET); } }],
    ['good', { async exclusive(operation) { order.push('exclusive'); await g.block(); return operation(); },
      finish(reason) { assert.equal(reason, 'shutdown'); order.push('finish'); } }],
  ]), sdk: { async shutdown() { order.push('sdk'); } },
  outbox: { async flush(timeout) { assert.equal(timeout, 5000); order.push('flush'); }, stop() { order.push('stop'); } } };
  const shutdown = shutdownApp(app);
  await g.ready;
  assert.ok(order.includes('sdk'), 'historical failure must not skip SDK shutdown');
  assert.ok(!order.includes('flush'));
  g.release();
  const report = await shutdown;
  assert.deepEqual(report, { closeFailures: [{ source: 'historical', code: 'HISTORICAL_CLOSE_FAILED' }], delivery: { status: 'flushed' } });
  assert.deepEqual(order.slice(-3), ['finish', 'flush', 'stop']);
});

test('actual historical session still closes once through shutdownApp with SDK disabled', async (t) => {
  const events = [];
  const app = createApp({ statsURL: 'http://go.test', statsFetcher: async (_url, init) => {
    events.push(JSON.parse(init.body)); return new Response('{}', { status: 201 });
  } });
  t.after(() => app.outbox.stop());
  const { Racing } = await import('../server/games.mjs');
  const match = new Racing((event) => app.outbox.enqueue(event));
  app.matches.set(match.id, match);
  assert.deepEqual(await shutdownApp(app), { closeFailures: [], delivery: { status: 'flushed' } });
  assert.equal(match.state, 'closed');
  await match.exclusive(() => match.finish('shutdown'));
  assert.equal(events.filter((e) => e.type === 'MATCH_FINISHED').length, 1);
});

test('SDK enumeration failure is sanitized, and server still attempts flush', async (t) => {
  const { app } = await setup(t);
  app.sdk.manager.list = async () => { throw new Error(SECRET); };
  let flushCalls = 0;
  app.outbox.flush = async () => { flushCalls++; };
  const report = await shutdownApp(app);
  assert.deepEqual(report.closeFailures, [{ source: 'sdk', code: 'SDK_ENUMERATION_FAILED' }]);
  assert.equal(report.delivery.status, 'flushed');
  assert.equal(flushCalls, 1);
});
