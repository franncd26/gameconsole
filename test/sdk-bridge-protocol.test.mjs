import test from 'node:test';
import assert from 'node:assert/strict';
import { copyJSON, envelope, fingerprint, validateMessage } from '../public/sdk/bridge/protocol.mjs';
import { snapshot, result } from './helpers/bridge.mjs';
const channel = 'a'.repeat(32);

test('Bridge v1 exact schemas accept READY exception and all seven channel messages', () => {
  const s = snapshot();
  for (const [type, payload] of [['INIT', { gameId: s.gameId, matchId: s.matchId, options: s.options, snapshot: s }],
    ['ACTION_REQUEST', { action: { type: 'ANY_ACTION', payload: {} } }], ['SNAPSHOT_REQUEST', {}],
    ['ACTION_RESULT', result(s)], ['SNAPSHOT', s], ['ERROR', { code: 'RESULT_UNKNOWN', message: 'Error saneado', unknown: true }], ['DETACH', { reason: 'reloaded' }]]) {
    assert.equal(validateMessage(envelope(type, 'id-1', payload, channel)).type, type);
  }
  assert.equal(envelope('READY', 'ready-1', {}).channelId, undefined);
  assert.throws(() => envelope('READY', 'ready', {}, channel));
});
test('rejects versions/protocols/unexpected fields/invalid IDs/channels/directions and executable values', () => {
  const valid = envelope('ACTION_REQUEST', 'id-1', { action: { type: 'TICK', payload: { direction: 'up' } } }, channel);
  for (const input of [null, [], { ...valid, protocol: 'other' }, { ...valid, version: 2 }, { ...valid, extra: 1 },
    { ...valid, channelId: 'x' }, { ...valid, messageId: 'x'.repeat(65) }, { ...valid, messageId: '\n' },
    { ...valid, payload: { action: { type: 'TICK', payload: {}, matchId: 'foreign' } } }]) assert.throws(() => validateMessage(input));
  assert.throws(() => validateMessage(valid, 'host'));
  const cyclic = {}; cyclic.self = cyclic;
  for (const v of [cyclic, { f() {} }, { x: NaN }, new Date(), { x: undefined }]) assert.throws(() => copyJSON(v));
  let called = false; const accessor = { get x() { called = true; return 1; } };
  assert.throws(() => copyJSON(accessor)); assert.equal(called, false);
});
test('bounded JSON, canonical property order and defensive copies', () => {
  const payload = { action: { type: 'TICK', payload: { a: 1, b: { x: 2, y: 3 } } } };
  const m = envelope('ACTION_REQUEST', 'id', payload, channel);
  payload.action.payload.a = 9; assert.equal(m.payload.action.payload.a, 1);
  assert.equal(fingerprint({ b: 2, a: { d: 3, c: 4 } }), fingerprint({ a: { c: 4, d: 3 }, b: 2 }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
  assert.throws(() => envelope('ACTION_REQUEST', 'id', { action: { type: 'TICK', payload: { text: 'é'.repeat(5000) } } }, channel));
  assert.throws(() => envelope('SNAPSHOT', 'id', { ...snapshot(), data: { text: 'x'.repeat(65536) } }, channel));
});
