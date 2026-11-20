import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, deferred, settle, snapshot as gameSnapshot } from './helpers/web-games.mjs';
import { PresentationCoordinator, readPreferences, savePreferences } from '../public/sdk/console-presentation.mjs';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
import { MatchWorkspace } from '../public/sdk/console-views.mjs';
import { Document, Window, Bridge, Clock, plugin, snapshot, dashboard } from './helpers/console-dom.mjs';

const presentation = overrides => ({ visible: true, canControl: true, autoPause: true, autoResume: true, ...overrides });
test('polled versions refresh spectators without racing the controller action snapshot read', async () => {
  const document = new Document(), bridge = new Bridge(), clock = new Clock();
  const workspace = new MatchWorkspace({ document, root: document.getElementById('workspace'), bridge, clock });
  workspace.open(snapshot('one'), 'One'); workspace.control('one', { canControl: true, supported: true });
  workspace.upsert(snapshot('one', 'alpha', 1)); await settle(); assert.equal(bridge.refreshes.length, 0);
  workspace.control('one', { canControl: false, supported: true });
  workspace.upsert(snapshot('one', 'alpha', 2)); await settle(); assert.equal(bridge.refreshes.length, 1);
  workspace.dispose();
});
for (const game of ['snake', 'racing']) {
  test(game + ': blur releases held input without disarming, manual pause survives visibility', async t => {
    const h = setup(game); t.after(() => h.controller.dispose());
    assert.equal(h.controller.presentationState, 'ready'); await h.controller.start();
    assert.equal(h.node('start').textContent, 'Pausa');
    h.window.fire('keydown', { key: 'w' }); h.window.fire('blur');
    assert.equal(h.clock.jobs.size, 1); assert.equal(h.controller.presentationState, 'playing');
    if (game === 'racing') assert.equal(h.controller.accelerate, false);
    await h.controller.start(); assert.equal(h.controller.presentationState, 'manuallyPaused');
    h.bridge.emit('presentation', presentation({ visible: false })); h.window.fire('focus');
    h.bridge.emit('presentation', presentation()); await settle();
    assert.equal(h.clock.jobs.size, 0); assert.equal(h.controller.presentationState, 'manuallyPaused');
    await h.controller.start(); assert.equal(h.clock.jobs.size, 1);
  });
  test(game + ': hidden suspension emits no tick, return waits for a controlled resync before resuming', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); await h.controller.start();
    h.bridge.emit('presentation', presentation({ visible: false }));
    assert.equal(h.controller.presentationState, 'autoSuspended'); await h.clock.step(); await h.controller.tick(); assert.equal(h.bridge.calls.length, 0);
    const gate = deferred(); h.bridge.requestSnapshot = () => gate.promise;
    h.bridge.emit('presentation', presentation()); assert.equal(h.controller.presentationState, 'resyncing'); assert.equal(h.clock.jobs.size, 0);
    gate.resolve(gameSnapshot(game)); await settle(); assert.equal(h.clock.jobs.size, 1); assert.equal(h.controller.presentationState, 'playing');
  });
  test(game + ': disabling autoPause keeps loop; disabling autoResume requires Continue', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); await h.controller.start();
    h.bridge.emit('presentation', presentation({ visible: false, autoPause: false }));
    assert.equal(h.clock.jobs.size, 1); await h.clock.step(); assert.equal(h.bridge.calls.length, 1);
    h.bridge.emit('presentation', presentation({ visible: false, autoResume: false }));
    h.bridge.emit('presentation', presentation({ autoResume: false })); await settle();
    assert.equal(h.clock.jobs.size, 0); assert.equal(h.node('start').textContent, 'Continuar');
    await h.controller.start(); assert.equal(h.clock.jobs.size, 1);
  });
  test(game + ': control loss gates actions and releases input; regaining requires synchronization', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); await h.controller.start();
    h.window.fire('keydown', { key: 'w' });
    h.bridge.emit('presentation', presentation({ canControl: false })); h.window.fire('focus');
    assert.equal(h.controller.presentationState, 'spectator'); assert.equal(h.clock.jobs.size, 0);
    if (game === 'racing') { assert.equal(h.controller.accelerate, false); assert.equal(h.controller.brake, false); }
    await h.controller.tick(); assert.equal(h.bridge.calls.length, 0);
    h.bridge.emit('presentation', presentation()); await settle(); assert.equal(h.clock.jobs.size, 1); assert.equal(h.bridge.reads, 2);
  });
  test(game + ': unknown receipt never resumes automatically, snapshot reads do not resolve uncertainty', async t => {
    const h = setup(game); t.after(() => h.controller.dispose());
    h.bridge.handler = async () => { throw Object.assign(Error('private'), { code: 'RESULT_UNKNOWN', unknown: true }); };
    await h.controller.start(); await h.clock.step();
    h.bridge.emit('presentation', presentation({ visible: false })); h.bridge.emit('presentation', presentation());
    await h.controller.sync(); await h.controller.start(); await h.clock.step();
    assert.equal(h.controller.presentationState, 'uncertain'); assert.equal(h.bridge.calls.length, 1); assert.equal(h.clock.jobs.size, 0);
  });
  test(game + ': losing control during pending action prevents rescheduling; detach invalidates late resync', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); const gate = deferred();
    h.bridge.handler = () => gate.promise; await h.controller.start(); await h.clock.step();
    h.bridge.emit('presentation', presentation({ canControl: false }));
    gate.resolve({ outcome: 'completed', committed: true, confirmations: 1 }); await settle(); assert.equal(h.clock.jobs.size, 0);
    const read = deferred(); h.bridge.requestSnapshot = () => read.promise;
    h.bridge.emit('presentation', presentation()); h.bridge.emit('detach', { reason: 'removed' });
    read.resolve(gameSnapshot(game)); await settle(); assert.equal(h.clock.jobs.size, 0); assert.equal(h.controller.disposed, true);
  });
  test(game + ': a visibility round trip during an explicit pending snapshot resumes once after that read', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); await h.controller.start();
    const read = deferred(); let first = true;
    h.bridge.requestSnapshot = async () => { if (first) { first = false; return read.promise; } return gameSnapshot(game); };
    const syncing = h.controller.sync();
    h.bridge.emit('presentation', presentation({ visible: false })); h.bridge.emit('presentation', presentation());
    assert.equal(h.clock.jobs.size, 0); read.resolve(gameSnapshot(game)); await syncing; await settle();
    assert.equal(h.clock.jobs.size, 1); assert.equal(h.controller.presentationState, 'playing');
  });
}

test('four Circuito presentation policies and clocks remain independent', async t => {
  const games = Array.from({ length: 4 }, () => setup('racing')); t.after(() => games.forEach(h => h.controller.dispose()));
  await Promise.all(games.map(h => h.controller.start()));
  games[0].bridge.emit('presentation', presentation({ visible: false }));
  games[1].bridge.emit('presentation', presentation({ visible: false, autoPause: false }));
  await games[2].controller.start(); games[3].bridge.emit('presentation', presentation({ canControl: false }));
  assert.deepEqual(games.map(h => h.clock.jobs.size), [0, 1, 0, 0]);
  assert.deepEqual(games.map(h => h.controller.presentationState), ['autoSuspended', 'playing', 'manuallyPaused', 'spectator']);
});
test('Gato manual actions are gated for spectators, including after focus', async t => {
  const h = setup('tic-tac-toe'); t.after(() => h.controller.dispose());
  h.bridge.emit('presentation', presentation({ canControl: false })); h.window.fire('focus');
  await h.controller.mark(0); await h.controller.act('PLACE_MARK', { index: 0 }); assert.equal(h.bridge.calls.length, 0);
  h.bridge.emit('presentation', presentation()); await settle(); await h.controller.mark(0); assert.equal(h.bridge.calls.length, 1);
});
test('host preferences reject malformed data and tolerate denied/unavailable localStorage', () => {
  for (const value of ['null', '{}', 'bad', '{"pauseWhenHidden":false,"resumeWhenVisible":"yes"}', '{"pauseWhenHidden":false,"resumeWhenVisible":true,"extra":true}']) {
    assert.deepEqual(readPreferences({ getItem: () => value }), { pauseWhenHidden: true, resumeWhenVisible: true });
  }
  const storage = { getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const preferences = { pauseWhenHidden: false, resumeWhenVisible: true };
  assert.equal(savePreferences(storage, preferences), true); assert.deepEqual(readPreferences(storage), preferences);
  assert.equal(savePreferences({ setItem() { throw Error(); } }, preferences), false);
  assert.deepEqual(readPreferences({ getItem() { throw Error(); } }), { pauseWhenHidden: true, resumeWhenVisible: true });
});

// Browser-like lock service shared by two host documents. No leases or steals.
class Locks {
  held = new Set(); queue = [];
  request(name, options, callback) {
    if (this.held.has(name) && options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const job = { name, options, callback, resolve, reject };
      options.signal?.addEventListener('abort', () => { this.queue = this.queue.filter(x => x !== job); reject(Object.assign(Error(), { name: 'AbortError' })); });
      this.queue.push(job); this.drain();
    });
  }
  drain() {
    for (const job of [...this.queue]) if (!this.held.has(job.name)) {
      this.queue = this.queue.filter(x => x !== job); this.held.add(job.name);
      Promise.resolve().then(() => job.callback({ name: job.name })).then(job.resolve, job.reject).finally(() => { this.held.delete(job.name); this.drain(); });
    }
  }
}
function coordinator(locks, gate, channel) {
  const states = [], errors = [], bridge = { setPresentation: (frame, p) => states.push({ frame, ...structuredClone(p) }), waitForIdle: async () => { if (gate) await gate.promise; } };
  const c = new PresentationCoordinator({ locks, bridge, channel, onError: e => errors.push(e) });
  const frames = new Map();
  const sync = (id, options = {}) => {
    if (!frames.has(id)) frames.set(id, { frame: {}, snapshot: { state: 'running' } });
    c.sync(frames, { section: 'play', mode: 'grid', hidden: false, preferences: { pauseWhenHidden: true, resumeWhenVisible: true }, ...options });
  };
  return { c, sync, states, frames, errors };
}
test('same-match hosts have one lock owner; explicit transfer waits for pending action, other UUID progresses', async () => {
  const locks = new Locks(), gate = deferred(), a = coordinator(locks, gate), b = coordinator(locks);
  a.sync('shared'); await settle(); b.sync('shared'); b.sync('other'); await settle();
  assert.equal(a.c.records.get('shared').owner, true); assert.equal(b.c.records.get('shared').owner, false); assert.equal(b.c.records.get('other').owner, true);
  b.c.take('shared'); const releasing = a.c.yield(a.c.records.get('shared')); await settle();
  assert.equal(a.states.at(-1).canControl, false); assert.equal(b.c.records.get('shared').owner, false);
  gate.resolve(); await releasing; await settle(); assert.equal(a.c.records.get('shared').owner, false); assert.equal(b.c.records.get('shared').owner, true);
  a.c.dispose(); b.c.dispose(); await settle(); assert.equal(locks.held.size, 0);
});
test('unknown pending action prevents transfer and reports clearly; removal aborts queued claims', async () => {
  const locks = new Locks(), gate = deferred(), a = coordinator(locks, gate), b = coordinator(locks);
  a.sync('shared'); await settle(); b.sync('shared'); await settle(); b.c.take('shared');
  const yielding = a.c.yield(a.c.records.get('shared')); gate.reject(Error('private')); await yielding; await settle();
  assert.equal(a.c.records.get('shared').owner, true); assert.equal(b.c.records.get('shared').owner, false); assert.match(a.errors[0], /desconocido/);
  b.c.dispose(); a.c.dispose(); await settle(); assert.equal(locks.held.size, 0);
});
test('missing Web Locks leaves single-tab play usable and explicitly marks unsupported exclusivity', () => {
  const states = [], c = new PresentationCoordinator({ bridge: { setPresentation() {} }, onChange: (_id, s) => states.push(s) });
  c.sync(new Map([['one', { frame: {}, snapshot: { state: 'running' } }]]), { section: 'play', mode: 'focus', selectedId: 'one', hidden: false, preferences: { pauseWhenHidden: true, resumeWhenVisible: true } });
  assert.equal(states.at(-1).canControl, true); assert.equal(states.at(-1).supported, false); c.dispose();
});
test('BroadcastChannel requests a cooperative handoff; Web Locks alone grants control and retired claims stay invalid', async () => {
  const peers = new Set();
  const channel = () => {
    const c = { listeners: new Set(), addEventListener: (_t, fn) => c.listeners.add(fn), removeEventListener: (_t, fn) => c.listeners.delete(fn),
      postMessage: data => { for (const other of peers) if (other !== c) queueMicrotask(() => { for (const fn of other.listeners) fn({ data }); }); }, close: () => peers.delete(c) };
    peers.add(c); return c;
  };
  const locks = new Locks(), pending = deferred(), a = coordinator(locks, pending, channel()), b = coordinator(locks, null, channel());
  a.sync('shared'); await settle(); b.sync('shared'); await settle(); b.c.take('shared'); await settle();
  assert.equal(a.c.records.get('shared').yielding, true); assert.equal(b.c.records.get('shared').owner, false);
  pending.resolve(); await settle(); assert.equal(b.c.records.get('shared').owner, true);
  a.c.take('shared'); a.c.dispose(); await settle(); assert.equal(a.c.records.size, 0);
  b.frames.get('shared').snapshot.state = 'finished'; b.sync('shared'); await settle(); assert.equal(locks.held.size, 0);
  b.c.dispose(); assert.equal(peers.size, 0);
});
test('normal unmount waits for pending transport before releasing its exclusive lock', async () => {
  const locks = new Locks(), pending = deferred(), a = coordinator(locks, pending), b = coordinator(locks);
  a.sync('shared'); await settle(); b.sync('shared'); await settle(); b.c.take('shared');
  a.c.remove('shared'); await settle(); assert.equal(b.c.records.get('shared').owner, false);
  pending.resolve(); await settle(); assert.equal(b.c.records.get('shared').owner, true);
  a.c.dispose(); b.c.dispose(); await settle(); assert.equal(locks.held.size, 0);
});
test('console derives focus/grid/section/hidden presentation without remounts and updates host-only preferences live', async t => {
  const doc = new Document(), window = new Window(), bridge = new Bridge(), clock = new Clock(), updates = [];
  bridge.setPresentation = (frame, p) => updates.push({ frame, ...structuredClone(p) });
  const stored = { getItem: () => null, setItem(_key, value) { this.value = value; } }; window.localStorage = stored;
  const matches = ['a', 'b', 'c', 'd'].map(id => snapshot(id));
  const api = { catalog: async () => [plugin()], matches: async () => matches, snapshot: async id => matches.find(s => s.matchId === id),
    results: async () => ({ status: 200, data: { gameId: 'alpha', matchId: 'a', state: 'open', metrics: [], patterns: [] } }), dashboard: async () => ({ status: 200, data: dashboard }) };
  const app = new ConsoleApp({ document: doc, window, bridge, clock, api }); t.after(() => app.dispose()); await app.init();
  for (const m of matches) await app.select(m.matchId);
  const frames = [...app.workspace.records.values()].map(r => r.frame);
  const latest = frame => updates.filter(p => p.frame === frame).at(-1);
  assert.deepEqual(frames.map(f => latest(f).visible), [false, false, false, true]);
  app.setMode('grid'); assert.ok(frames.every(f => latest(f).visible)); app.setSection('analytics'); assert.ok(frames.every(f => !latest(f).visible));
  doc.getElementById('pauseWhenHidden').checked = false; doc.getElementById('pauseWhenHidden').fire('change');
  assert.ok(frames.every(f => !latest(f).autoPause)); assert.equal(JSON.parse(stored.value).pauseWhenHidden, false);
  app.setSection('play'); doc.hidden = true; doc.fire('visibilitychange'); assert.ok(frames.every(f => !latest(f).visible));
  assert.equal(bridge.mounts.length, 4); assert.equal(bridge.unmounts.length, 0);
});
