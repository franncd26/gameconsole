import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameBridgeClient } from '../public/sdk/bridge/game-client.mjs';
import { envelope } from '../public/sdk/bridge/protocol.mjs';
import { windows, snapshot, result, settle } from './helpers/bridge.mjs';
const channel = 'c'.repeat(32);
function setup(t) {
  const p = windows(), client = createGameBridgeClient({ window: p.game, hostOrigin: 'http://console.test' });
  t.after(() => client.dispose());
  const ready = p.outbound[0].data.messageId;
  const send = (type, id, value, token = channel, extra = {}) => p.game.emit('message', {
    data: envelope(type, id, value, token), origin: 'http://console.test', source: p.parent, ...extra,
  });
  const init = (s = snapshot()) => send('INIT', ready, { gameId: s.gameId, matchId: s.matchId, options: s.options, snapshot: s });
  return { ...p, client, ready, send, init };
}
test('client checks actual parent origin/source/nonce and rejects requests before INIT', async (t) => {
  const h = setup(t), s = snapshot();
  await assert.rejects(h.client.dispatch('ANY', {}), { code: 'BRIDGE_NOT_READY' });
  const init = { gameId: s.gameId, matchId: s.matchId, options: s.options, snapshot: s };
  h.send('INIT', h.ready, init, channel, { origin: 'null' }); assert.equal(h.client.getIdentity(), null);
  h.send('INIT', h.ready, init, channel, { source: {} }); assert.equal(h.client.getIdentity(), null);
  h.send('INIT', 'other-ready', init); assert.equal(h.client.getIdentity(), null);
  h.init(); assert.equal(h.client.getIdentity().matchId, 'match-a');
  assert.equal(h.outbound[0].origin, 'http://console.test');
});
test('Observer callbacks are independent defensive copies, unsubscribe works and stale snapshots cannot roll back', () => {
  const h = setup({ after() {} }), observed = [];
  h.client.onSnapshot((s) => { s.data.count = 999; });
  const off = h.client.onSnapshot((s) => observed.push(s));
  h.init(snapshot('alpha', 'match-a', 5));
  assert.equal(observed[0].data.count, 5); assert.equal(h.client.getSnapshot().data.count, 5);
  h.send('SNAPSHOT', 'old', snapshot('alpha', 'match-a', 2)); assert.equal(h.client.getSnapshot().version, 5);
  off(); h.send('SNAPSHOT', 'new', snapshot('alpha', 'match-a', 6)); assert.equal(observed.length, 1);
  h.client.dispose();
});
test('action results preserve original snapshot but do not automatically replace a newer observed state', async (t) => {
  const h = setup(t); h.init(snapshot('alpha', 'match-a', 9));
  const results = []; h.client.onResult((r) => results.push(r));
  const pending = h.client.dispatch('ANY', {}, { messageId: 'replay' });
  h.send('ACTION_RESULT', 'replay', result(snapshot('alpha', 'match-a', 1)));
  assert.equal((await pending).snapshot.version, 1); assert.equal(results[0].snapshot.version, 1);
  assert.equal(h.client.getSnapshot().version, 9);
  const read = h.client.requestSnapshot({ messageId: 'read' }); h.send('SNAPSHOT', 'read', snapshot('alpha', 'match-a', 10));
  assert.equal((await read).version, 10);
});
test('wrong token and identity cannot resolve operations; ERROR and dispose sanitize/cancel pending listeners', async (t) => {
  const h = setup(t); h.init();
  const pending = h.client.dispatch('ANY', {}, { messageId: 'pending' }); let settled = false; pending.catch(() => { settled = true; });
  h.send('ACTION_RESULT', 'pending', result(snapshot()), 'd'.repeat(32));
  h.send('ACTION_RESULT', 'pending', result(snapshot('foreign', 'foreign-match'))); await settle(); assert.equal(settled, false);
  const rejection = assert.rejects(pending, { code: 'RESULT_UNKNOWN', unknown: true });
  h.send('ERROR', 'pending', { code: 'RESULT_UNKNOWN', message: 'Error saneado.', unknown: true }); await rejection;
  const second = h.client.requestSnapshot(); const closed = assert.rejects(second, { code: 'BRIDGE_DETACHED' });
  h.client.dispose(); await closed; assert.equal(h.game.listeners.get('message').size, 0); assert.equal(h.game.listeners.get('load').size, 0);
});
test('messageId conflicts, JSON validation and bounded pending operations never post executable payloads', async (t) => {
  const h = setup(t); h.init();
  const one = h.client.dispatch('ANY', { a: 1 }, { messageId: 'same' });
  assert.equal(h.client.dispatch('ANY', { a: 1 }, { messageId: 'same' }), one);
  await assert.rejects(h.client.dispatch('ANY', { a: 2 }, { messageId: 'same' }), { code: 'MESSAGE_CONFLICT' });
  await assert.rejects(h.client.dispatch('ANY', { f() {} }), { code: 'INVALID_MESSAGE' });
  const rest = [h.client.requestSnapshot(), h.client.requestSnapshot(), h.client.requestSnapshot()];
  await assert.rejects(h.client.requestSnapshot(), { code: 'BRIDGE_BUSY' });
  const cancelled = [one, ...rest].map((p) => assert.rejects(p, { code: 'BRIDGE_DETACHED' }));
  h.client.dispose(); await Promise.all(cancelled);
});
