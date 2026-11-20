import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { HostBridge } from '../public/sdk/bridge/host-bridge.mjs';
import { createGameBridgeClient } from '../public/sdk/bridge/game-client.mjs';
import { envelope } from '../public/sdk/bridge/protocol.mjs';
import { windows, snapshot, result, response, settle, gate } from './helpers/bridge.mjs';

async function connected(t, options = {}) {
  const pair = windows(), state = { snapshot: snapshot(), posts: [], reads: 0, handler: null }, status = [];
  const fetcher = async (url, init = {}) => {
    if (init.method === 'POST') {
      const action = JSON.parse(init.body); state.posts.push({ url, action });
      if (state.handler) return state.handler(action);
      state.snapshot = snapshot('alpha', 'match-a', state.snapshot.version + 1);
      return response(result(state.snapshot));
    }
    state.reads++; return response(state.snapshot);
  };
  const host = new HostBridge({ window: pair.host, fetcher, onStatus: (s) => status.push(s) });
  host.attach(pair.frame, state.snapshot, { loaded: options.loaded ?? true });
  const client = createGameBridgeClient({ window: pair.game, hostOrigin: 'http://console.test' });
  t.after(() => { client.dispose(); host.dispose(); });
  await settle();
  return { ...pair, hostWindow: pair.host, host, client, state, status };
}
test('READY/INIT bind exact iframe, duplicate READY keeps channel, and initial load ordering is supported', async (t) => {
  const h = await connected(t, { loaded: false });
  assert.equal(h.client.getIdentity(), null); h.frame.emit('load'); await settle();
  assert.equal(h.client.getIdentity().matchId, 'match-a');
  const init = h.inbound.filter((m) => m.data.type === 'INIT').at(-1);
  assert.equal(init.origin, '*'); assert.match(init.data.channelId, /^[a-f0-9]{32}$/);
  h.client.ready(); await settle();
  assert.equal(h.inbound.at(-1).data.channelId, init.data.channelId);
});
test('wrong source/origin/channel/protocol/version cannot dispatch; reload invalidates late channel', async (t) => {
  const h = await connected(t), channel = h.inbound[0].data.channelId;
  const m = envelope('ACTION_REQUEST', 'bad', { action: { type: 'ANY', payload: {} } }, channel);
  for (const event of [{ data: m, origin: 'null', source: {} }, { data: m, origin: 'http://other.test', source: h.child },
    { data: { ...m, channelId: 'b'.repeat(32) }, origin: 'null', source: h.child },
    { data: { ...m, version: 2 }, origin: 'null', source: h.child }, { data: { ...m, protocol: 'foreign' }, origin: 'null', source: h.child }]) h.hostWindow.emit('message', event);
  h.parent.postMessage({ ...m, channelId: 'b'.repeat(32) }, 'http://console.test');
  await settle(); assert.equal(h.state.posts.length, 0);
  h.client.dispose(); h.frame.emit('load');
  h.parent.postMessage(m, 'http://console.test'); await settle(); assert.equal(h.state.posts.length, 0);
  const next = createGameBridgeClient({ window: h.game, hostOrigin: 'http://console.test' }); t.after(() => next.dispose());
  await settle(); assert.notEqual(h.inbound.filter((x) => x.data.type === 'INIT').at(-1).data.channelId, channel);
});
test('generic dispatch routes only to assigned match and preserves partial/replayed results with current snapshot', async (t) => {
  const h = await connected(t);
  h.state.handler = async () => {
    h.state.snapshot = snapshot('alpha', 'match-a', 1);
    return response(result(h.state.snapshot, { outcome: 'dependency_failed', error: { code: 'PLUGIN_OPERATION_FAILED', message: 'Falló una dependencia.' } }));
  };
  const first = await h.client.dispatch('SOME_PLUGIN_ACTION', { b: 2, a: 1 }, { messageId: 'op-1' });
  await settle(); assert.equal(first.outcome, 'dependency_failed'); assert.equal(first.committed, true);
  assert.equal(h.state.posts[0].url, '/api/sdk/matches/match-a/actions');
  const action = h.state.posts[0].action;
  assert.equal(action.expectedVersion, 0); assert.ok(action.requestId.length <= 128); assert.match(action.requestId, /^bridge:/);
  h.state.snapshot = snapshot('alpha', 'match-a', 5);
  assert.deepEqual(await h.client.dispatch('SOME_PLUGIN_ACTION', { a: 1, b: 2 }, { messageId: 'op-1' }), first);
  await settle(); assert.equal(h.state.posts.length, 1); assert.equal(h.client.getSnapshot().version, 5);
  await assert.rejects(h.client.dispatch('SOME_PLUGIN_ACTION', { a: 9 }, { messageId: 'op-1' }), { code: 'MESSAGE_CONFLICT' });
});
test('in-flight identical requests share execution; per-channel admission rejects a new action without a queue', async (t) => {
  const h = await connected(t), g = gate(); t.after(g.release);
  h.state.handler = async () => { await g.promise; return response(result(snapshot('alpha', 'match-a', 1))); };
  const one = h.client.dispatch('ANY', {}, { messageId: 'same' });
  const two = h.client.dispatch('ANY', {}, { messageId: 'same' }); assert.equal(one, two);
  await settle();
  await assert.rejects(h.client.dispatch('OTHER', {}, { messageId: 'other' }), { code: 'BRIDGE_BUSY' });
  g.release(); await one; await settle(); assert.equal(h.state.posts.length, 1);
});
test('HTTP unknown outcome is sanitized; snapshot recovery and manual retry use the exact original SDK request', async (t) => {
  const h = await connected(t); let attempts = 0;
  h.state.handler = async () => {
    if (++attempts === 1) { h.state.snapshot = snapshot('alpha', 'match-a', 1); throw new Error('C:/private/server.mjs secret stack'); }
    return response(result(snapshot('alpha', 'match-a', 1)));
  };
  const errors = []; h.client.onError((e) => errors.push(e));
  await assert.rejects(h.client.dispatch('ANY', {}, { messageId: 'unknown' }), { code: 'RESULT_UNKNOWN', unknown: true });
  await settle(); assert.equal((await h.client.requestSnapshot()).version, 1);
  await h.client.dispatch('ANY', {}, { messageId: 'unknown' }); await settle();
  assert.deepEqual(h.state.posts[0].action, h.state.posts[1].action);
  assert.ok(!/private|secret|stack/.test(JSON.stringify(errors)));
});
test('VERSION_CONFLICT remains a result and snapshot resynchronizes without retrying a different version', async (t) => {
  const h = await connected(t);
  h.state.handler = async () => { h.state.snapshot = snapshot('alpha', 'match-a', 8); return response(result(h.state.snapshot, {
    outcome: 'rejected', committed: false, confirmations: 0, error: { code: 'VERSION_CONFLICT', message: 'Versión incompatible.' },
  }), 409); };
  const r = await h.client.dispatch('ANY', {}); assert.equal(r.error.code, 'VERSION_CONFLICT');
  await settle(); assert.equal(h.client.getSnapshot().version, 8); assert.equal(h.state.posts.length, 1);
});
test('multiple channels stay independent; detach cancels only its client and ignores late HTTP completion', async (t) => {
  const a = await connected(t), b = await connected(t), g = gate(); t.after(g.release);
  a.state.handler = async () => { await g.promise; return response(result(snapshot('alpha', 'match-a', 1))); };
  const pending = a.client.dispatch('ANY', {}); await settle();
  assert.equal((await b.client.dispatch('OTHER', {})).snapshot.version, 1);
  const rejection = assert.rejects(pending, { code: 'BRIDGE_DETACHED' }); a.host.detach(a.frame); await rejection;
  g.release(); await settle();
  assert.equal(a.client.getIdentity(), null); assert.equal(b.client.getIdentity().matchId, 'match-a');
  assert.equal(a.game.listeners.get('message').size, 0, 'permanent detach releases game-side listener');
});

test('one HostBridge handles three different iframe windows and assigned matches without cross-channel dispatch', async (t) => {
  const pairs = [windows()]; pairs.push(windows(pairs[0].host), windows(pairs[0].host));
  const states = pairs.map((_, i) => snapshot(`plugin-${i}`, `match-${i}`)), posts = [];
  const host = new HostBridge({ window: pairs[0].host, fetcher: async (url, init = {}) => {
    const index = Number(/match-(\d)/.exec(url)[1]);
    if (init.method === 'POST') { posts.push({ index, body: JSON.parse(init.body) }); states[index] = snapshot(`plugin-${index}`, `match-${index}`, states[index].version + 1); return response(result(states[index])); }
    return response(states[index]);
  } });
  const clients = pairs.map((p, i) => { host.attach(p.frame, states[i], { loaded: true }); return createGameBridgeClient({ window: p.game, hostOrigin: 'http://console.test' }); });
  t.after(() => { clients.forEach((c) => c.dispose()); host.dispose(); });
  await settle();
  const channels = pairs.map((p) => p.inbound[0].data.channelId); assert.equal(new Set(channels).size, 3);
  const results = await Promise.all(clients.map((c) => c.dispatch('SAME_ACTION', {}, { messageId: 'same' })));
  assert.deepEqual(results.map((r) => r.snapshot.matchId), ['match-0', 'match-1', 'match-2']);
  assert.equal(new Set(posts.map((p) => p.body.requestId)).size, 3);
  host.detach(pairs[0].frame); await settle();
  assert.equal(clients[0].getIdentity(), null); assert.equal((await clients[2].dispatch('ANY', {})).snapshot.version, 2);
});

test('default browser fetch keeps its Window/global receiver (real browser regression)', async (t) => {
  const p = windows();
  t.mock.method(globalThis, 'fetch', function () {
    assert.equal(this, globalThis, 'native Window.fetch must not receive HostBridge as this');
    return Promise.resolve(response(snapshot()));
  });
  const host = new HostBridge({ window: p.host }); host.attach(p.frame, snapshot(), { loaded: true });
  const client = createGameBridgeClient({ window: p.game, hostOrigin: 'http://console.test' });
  t.after(() => { client.dispose(); host.dispose(); });
  await settle(); assert.equal(client.getIdentity().matchId, 'match-a');
});

test('failed snapshot recovery blocks new actions until explicit resynchronization succeeds', async (t) => {
  const p = windows(); let failRead = false, posts = 0;
  const host = new HostBridge({ window: p.host, fetcher: async (_url, init = {}) => {
    if (init.method === 'POST') { posts++; failRead = true; throw Error('private network exception'); }
    if (failRead) throw Error('private snapshot exception');
    return response(snapshot());
  } }); host.attach(p.frame, snapshot(), { loaded: true });
  const client = createGameBridgeClient({ window: p.game, hostOrigin: 'http://console.test' });
  t.after(() => { client.dispose(); host.dispose(); }); await settle();
  await assert.rejects(client.dispatch('ANY', {}, { messageId: 'unknown' }), { code: 'RESULT_UNKNOWN' }); await settle();
  await assert.rejects(client.dispatch('OTHER', {}), { code: 'RESYNC_REQUIRED' }); assert.equal(posts, 1);
  failRead = false; assert.equal((await client.requestSnapshot()).version, 0);
});

test('HostBridge coalesces raw concurrent replays and bounds completed channel history to 128 FIFO entries', async (t) => {
  const h = await connected(t), g = gate(); t.after(g.release);
  h.state.handler = async () => { await g.promise; return response(result(snapshot('alpha', 'match-a', 1))); };
  const channel = h.inbound[0].data.channelId;
  const m = envelope('ACTION_REQUEST', 'raw', { action: { type: 'ANY', payload: {} } }, channel);
  h.parent.postMessage(m, 'http://console.test'); h.parent.postMessage(m, 'http://console.test');
  await settle(); assert.equal(h.state.posts.length, 1); g.release(); await settle();
  h.state.handler = null;
  await h.client.dispatch('ANY', {}, { messageId: 'fifo-first' }); await settle();
  for (let i = 0; i < 128; i++) { await h.client.dispatch('ANY', {}, { messageId: `fifo-${i}` }); await settle(); }
  const count = h.state.posts.length;
  await h.client.dispatch('ANY', {}, { messageId: 'fifo-first' }); await settle();
  assert.equal(h.state.posts.length, count + 1, 'evicted history no longer promises Bridge replay; SDK receives the stable ID');
});

test('oversized committed result reports unknown receipt instead of hanging or claiming rollback', async (t) => {
  const h = await connected(t);
  h.state.handler = async () => {
    h.state.snapshot = { ...snapshot('alpha', 'match-a', 1), data: { text: 'x'.repeat(65536) } };
    return response(result(h.state.snapshot));
  };
  await assert.rejects(h.client.dispatch('ANY', {}), { code: 'BRIDGE_MESSAGE_TOO_LARGE', unknown: true });
  assert.equal(h.state.snapshot.version, 1); await settle();
});

test('Bridge client → HostBridge → real HTTP SDK → authentic plugins preserves routing, versions and replay', async (t) => {
  const app = createApp({ sdk: await prepareSDK({ pluginsDirectory: fileURLToPath(new URL('../plugins/', import.meta.url)),
    trustedIds: ['snake', 'racing', 'tic-tac-toe'] }), statsURL: 'http://go.test', statsFetcher: async () => new Response('{}', { status: 201 }) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.outbox.stop(); app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); });
  const snapshots = await Promise.all(['snake', 'racing', 'tic-tac-toe'].map(async (id) => {
    const s = await app.sdk.manager.create(id); return app.sdk.manager.activate(s.matchId);
  }));
  const pairs = [windows()]; pairs.push(windows(pairs[0].host));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const host = new HostBridge({ window: pairs[0].host, fetcher: (route, init) => fetch(base + route, init) });
  const clients = pairs.map((p, i) => { host.attach(p.frame, snapshots[i], { loaded: true }); return createGameBridgeClient({ window: p.game, hostOrigin: 'http://console.test' }); });
  t.after(() => { clients.forEach((c) => c.dispose()); host.dispose(); });
  await Promise.all(clients.map((client) => new Promise((resolve) => { const off = client.onInit(() => { queueMicrotask(() => off()); resolve(); }); })));
  const actions = [['TICK', { direction: 'right' }], ['STEP', { lane: 2, accelerate: true, brake: false }]];
  const results = await Promise.all(clients.map((c, i) => c.dispatch(...actions[i], { messageId: 'http-op' })));
  assert.deepEqual(results.map((r) => r.snapshot.gameId), ['snake', 'racing']);
  assert.ok(results.every((r) => r.committed && r.snapshot.version === 1));
  const replay = await clients[0].dispatch(...actions[0], { messageId: 'http-op' }); assert.deepEqual(replay, results[0]);
  assert.equal((await app.sdk.manager.getSnapshot(snapshots[0].matchId)).version, 1);
  assert.equal((await app.sdk.manager.getSnapshot(snapshots[2].matchId)).data.turn, 0, 'Gato never calls Prolog');
});
