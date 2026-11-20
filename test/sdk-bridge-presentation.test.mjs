import test from 'node:test';
import assert from 'node:assert/strict';
import { HostBridge } from '../public/sdk/bridge/host-bridge.mjs';
import { createGameBridgeClient } from '../public/sdk/bridge/game-client.mjs';
import { envelope, validateMessage } from '../public/sdk/bridge/protocol.mjs';
import { windows, snapshot, result, response, settle, gate } from './helpers/bridge.mjs';
const p = { visible: true, canControl: false, autoPause: true, autoResume: true };

test('PRESENTATION strict JSON schema, host-only direction, no SDK identity fields', () => {
  const m = envelope('PRESENTATION', 'present', p, 'a'.repeat(32));
  assert.deepEqual(validateMessage(m, 'host').payload, p);
  assert.throws(() => validateMessage(m, 'game'));
  for (const payload of [{ ...p, matchId: 'arbitrary' }, { ...p, canControl: 1 }, { ...p, visible: null }, { ...p, autoPause: undefined }]) {
    assert.throws(() => envelope('PRESENTATION', 'present', payload, 'a'.repeat(32)));
  }
  const getter = { ...p }; Object.defineProperty(getter, 'visible', { enumerable: true, get() { throw Error('must not execute'); } });
  assert.throws(() => envelope('PRESENTATION', 'present', getter, 'a'.repeat(32)), { code: 'INVALID_MESSAGE' });
});
async function connected(t) {
  const pair = windows(), state = { snapshot: snapshot(), calls: 0 }, pending = gate();
  const host = new HostBridge({ window: pair.host, fetcher: async (_url, init = {}) => {
    if (init.method === 'POST') { state.calls++; if (state.wait) await pending.promise; if (state.fail) throw Error('private'); state.snapshot = snapshot('alpha', 'match-a', state.snapshot.version + 1); return response(result(state.snapshot)); }
    return response(state.snapshot);
  } });
  host.attach(pair.frame, state.snapshot, { loaded: true });
  host.setPresentation(pair.frame, p);
  const client = createGameBridgeClient({ window: pair.game, hostOrigin: 'http://console.test' });
  t.after(() => { client.dispose(); host.dispose(); }); await settle();
  return { ...pair, bridge: host, client, state, pending };
}
test('presentation retained across handshake and late subscribers, defensive observers, wrong source/channel rejected', async t => {
  const h = await connected(t); assert.deepEqual(h.client.getPresentation(), p);
  h.client.onPresentation(value => { value.visible = false; });
  let observed; h.client.onPresentation(value => { observed = value; }); assert.deepEqual(observed, p);
  const channel = h.inbound[0].data.channelId;
  const forged = envelope('PRESENTATION', 'fake', { ...p, canControl: true }, 'b'.repeat(32));
  h.game.emit('message', { source: h.parent, origin: 'http://console.test', data: forged });
  h.game.emit('message', { source: {}, origin: 'http://console.test', data: { ...forged, channelId: channel } });
  assert.deepEqual(h.client.getPresentation(), p);
  await assert.rejects(h.client.dispatch('ANY', {}), { code: 'SPECTATOR' }); assert.equal(h.state.calls, 0);
  await h.client.requestSnapshot(); assert.equal(h.client.getSnapshot().version, 0);
  assert.equal(h.state.calls, 0, 'presentation and observer reads never dispatch SDK actions');
});
test('revoking control rejects late manual action, drains accepted operation and does not duplicate it', async t => {
  const h = await connected(t); h.bridge.setPresentation(h.frame, { ...p, canControl: true }); await settle();
  h.state.wait = true; const action = h.client.dispatch('ANY', {}, { messageId: 'once' }); await settle();
  h.bridge.setPresentation(h.frame, p); let idle = false; const drain = h.bridge.waitForIdle(h.frame).then(() => { idle = true; });
  await assert.rejects(h.client.dispatch('ANY', {}, { messageId: 'late' }), { code: 'SPECTATOR' }); assert.equal(idle, false);
  h.pending.release(); await action; await drain; assert.equal(h.state.calls, 1); assert.equal(h.client.getSnapshot().version, 1);
  h.bridge.unmount(h.frame); await settle(); assert.equal(h.client.getPresentation(), null);
});
test('unknown receipt blocks transfer even after snapshot recovery; original replay can resolve it', async t => {
  const h = await connected(t); h.bridge.setPresentation(h.frame, { ...p, canControl: true }); await settle(); h.state.fail = true;
  await assert.rejects(h.client.dispatch('ANY', {}, { messageId: 'unknown' }), { code: 'RESULT_UNKNOWN' }); await settle();
  await h.client.requestSnapshot(); await assert.rejects(h.bridge.waitForIdle(h.frame), { code: 'RESULT_UNKNOWN' });
  h.state.fail = false; await h.client.dispatch('ANY', {}, { messageId: 'unknown' }); await h.bridge.waitForIdle(h.frame);
  assert.equal(h.state.snapshot.version, 1);
});
