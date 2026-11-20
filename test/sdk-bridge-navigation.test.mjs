import test from 'node:test';
import assert from 'node:assert/strict';
import { HostBridge } from '../public/sdk/bridge/host-bridge.mjs';
import { createGameBridgeClient } from '../public/sdk/bridge/game-client.mjs';
import { envelope, validateMessage, navigationDirection } from '../public/sdk/bridge/protocol.mjs';
import { windows, snapshot, response, settle } from './helpers/bridge.mjs';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
import { Document, Window, Bridge, Clock, plugin, dashboard } from './helpers/console-dom.mjs';
import { setup as game } from './helpers/web-games.mjs';

const shortcut = overrides => ({ key: 'k', ctrlKey: true, altKey: true, preventDefault() { this.prevented = true; }, ...overrides });
test('navigation schema is game-to-host only and never accepts a destination match ID or executable payload', () => {
  const m = envelope('NAVIGATION_REQUEST', 'next', { direction: 'next' }, 'a'.repeat(32));
  assert.equal(validateMessage(m, 'game').payload.direction, 'next'); assert.throws(() => validateMessage(m, 'host'));
  for (const payload of [{ direction: 'next', matchId: 'arbitrary' }, { direction: 'sideways' }, { direction: 1 }, {}]) assert.throws(() => envelope('NAVIGATION_REQUEST', 'next', payload, 'a'.repeat(32)));
  for (const event of [{ repeat: true }, { altKey: false }, { metaKey: true }, { target: { tagName: 'SELECT' } }, { target: { closest: () => ({}) } }]) assert.equal(navigationDirection(shortcut(event)), null);
});
test('iframe shortcuts reach only its validated host association; repeats, editable targets and stale channels do not navigate', async t => {
  const pair = windows(), navigation = [], reads = [], state = snapshot('racing', 'source');
  const host = new HostBridge({ window: pair.host, onNavigate: event => navigation.push(event), fetcher: async (url, init) => { reads.push({ url, init }); return response(state); } });
  host.attach(pair.frame, state, { loaded: true }); host.setPresentation(pair.frame, { visible: true, canControl: false, autoPause: true, autoResume: true });
  const client = createGameBridgeClient({ window: pair.game, hostOrigin: 'http://console.test' }); t.after(() => { client.dispose(); host.dispose(); }); await settle();
  pair.game.emit('keydown', shortcut()); await settle(); assert.deepEqual(navigation, [{ matchId: 'source', direction: 'next' }]);
  assert.equal(reads.length, 1, 'navigation and spectator focus generate no SDK actions or snapshot fetches');
  const sent = pair.outbound.find(m => m.data.type === 'NAVIGATION_REQUEST').data;
  pair.parent.postMessage(sent, 'http://console.test'); await settle(); assert.equal(navigation.length, 1, 'duplicate message ID is ignored');
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) pair.game.emit('keydown', shortcut({ target }));
  pair.game.emit('keydown', shortcut({ repeat: true })); pair.game.emit('keydown', shortcut({ key: 'w' }));
  const fake = envelope('NAVIGATION_REQUEST', 'foreign', { direction: 'previous' }, 'b'.repeat(32));
  pair.host.emit('message', { data: fake, source: pair.child, origin: 'null' });
  pair.host.emit('message', { data: { ...fake, channelId: sent.channelId }, source: {}, origin: 'null' });
  await settle(); assert.equal(navigation.length, 1);
  host.unmount(pair.frame); pair.parent.postMessage({ ...sent, messageId: 'late' }, 'http://console.test'); await settle(); assert.equal(navigation.length, 1);
  pair.game.emit('keydown', shortcut()); await settle(); assert.equal(navigation.length, 1);
});
test('real iframe Bridge navigation selects/focuses the destination and blur releases held pedals without pausing other running games', async t => {
  const document = new Document(), window = new Window(), bridge = new Bridge(), clock = new Clock();
  const matches = ['a', 'b', 'c'].map(id => snapshot('racing', id));
  const api = { catalog: async () => [plugin('racing')], matches: async () => matches, snapshot: async id => matches.find(m => m.matchId === id),
    results: async id => ({ status: 200, data: { matchId: id, gameId: 'racing', state: 'open', metrics: [], patterns: [] } }), dashboard: async () => ({ status: 200, data: dashboard }) };
  const app = new ConsoleApp({ document, window, bridge, clock, api }); t.after(() => app.dispose()); await app.init();
  for (const m of matches) await app.select(m.matchId); app.setMode('grid');
  const games = matches.map(() => game('racing')); t.after(() => games.forEach(h => h.controller.dispose()));
  await Promise.all(games.map(h => h.controller.start())); games[2].window.fire('keydown', { key: 'w' }); assert.equal(games[2].controller.accelerate, true);
  for (const [index, m] of matches.entries()) app.workspace.records.get(m.matchId).frame.contentWindow = { focus() {
    games.forEach((h, i) => h.window.fire(i === index ? 'focus' : 'blur'));
  } };
  const pair = windows(), host = new HostBridge({ window: pair.host, onNavigate: event => app.navigate(event.direction, event.matchId), fetcher: async () => response(matches[2]) });
  host.attach(pair.frame, matches[2], { loaded: true }); const client = createGameBridgeClient({ window: pair.game, hostOrigin: 'http://console.test' });
  t.after(() => { client.dispose(); host.dispose(); }); await settle(); pair.game.emit('keydown', shortcut()); await settle();
  assert.equal(app.selectedId, 'a'); assert.equal(app.workspace.records.get('a').frame.focusCount, 1);
  assert.equal(games[2].controller.accelerate, false); assert.ok(games.every(h => h.controller.armed));
  assert.equal(bridge.mounts.length, 3); assert.equal(bridge.unmounts.length, 0);
});
