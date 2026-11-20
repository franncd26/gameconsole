import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, deferred, settle as gameSettle } from './helpers/web-games.mjs';
import { GridResultsCoordinator } from '../public/sdk/console-grid-stats.mjs';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
import { Document, Window, Bridge, Clock, plugin, snapshot, dashboard, settle } from './helpers/console-dom.mjs';

for (const game of ['snake', 'racing']) {
  test(game + ': playing/Pause stays stable across normal actions and their snapshot reads, without redundant control writes', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); await h.controller.start();
    const start = h.node('start'), connection = h.node('connection');
    let label = start.textContent, disabled = start.disabled, labelWrites = 0, disabledWrites = 0;
    Object.defineProperty(start, 'textContent', { get: () => label, set: v => { label = v; labelWrites++; } });
    Object.defineProperty(start, 'disabled', { get: () => disabled, set: v => { disabled = v; disabledWrites++; } });
    for (let i = 0; i < 3; i++) {
      const gate = deferred(), read = deferred(); h.bridge.handler = () => gate.promise;
      h.bridge.requestSnapshot = () => read.promise;
      await h.clock.step(); assert.equal(start.textContent, 'Pausa'); assert.equal(start.disabled, false); assert.equal(connection.textContent, 'Jugando');
      gate.resolve({ outcome: 'completed', committed: true, confirmations: 1 }); await gameSettle();
      assert.equal(start.textContent, 'Pausa'); assert.equal(connection.textContent, 'Jugando');
      read.resolve(h.bridge.getSnapshot()); await gameSettle();
    }
    assert.equal(h.bridge.calls.length, 3); assert.equal(labelWrites, 0); assert.equal(disabledWrites, 0);
  });
  test(game + ': Pause during a pending normal action drains it and never schedules another tick', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); const gate = deferred();
    h.bridge.handler = () => gate.promise; await h.controller.start(); await h.clock.step();
    assert.equal(h.node('start').disabled, false); h.node('start').fire('click');
    assert.equal(h.controller.manuallyPaused, true); assert.equal(h.node('start').textContent, 'Continuar'); assert.equal(h.node('start').disabled, true);
    gate.resolve({ outcome: 'completed', committed: true, confirmations: 1 }); await gameSettle();
    assert.equal(h.bridge.calls.length, 1); assert.equal(h.clock.jobs.size, 0); assert.equal(h.node('start').disabled, false);
    assert.equal(h.node('start').textContent, 'Continuar');
  });
  test(game + ': initial/recovery sync is visible and uncertain network failure still blocks ticks', async t => {
    const h = setup(game); t.after(() => h.controller.dispose()); const read = deferred(); h.bridge.requestSnapshot = () => read.promise;
    const starting = h.controller.start(); assert.equal(h.node('start').textContent, 'Esperando sincronización'); assert.equal(h.node('connection').textContent, 'Sincronizando');
    read.resolve(h.bridge.getSnapshot()); await starting;
    const recovering = deferred(); h.bridge.emit('presentation', { visible: false, canControl: true, autoPause: true, autoResume: true });
    h.bridge.requestSnapshot = () => recovering.promise;
    h.bridge.emit('presentation', { visible: true, canControl: true, autoPause: true, autoResume: true });
    assert.equal(h.node('start').textContent, 'Esperando sincronización'); assert.equal(h.node('connection').textContent, 'Sincronizando');
    recovering.resolve(h.bridge.getSnapshot()); await gameSettle(); assert.equal(h.node('start').textContent, 'Pausa');
    h.bridge.requestSnapshot = async () => h.bridge.getSnapshot();
    h.bridge.handler = async () => { throw { code: 'RESULT_UNKNOWN', unknown: true }; };
    await h.clock.step(); assert.equal(h.node('start').textContent, 'Revisar resultado'); assert.equal(h.clock.jobs.size, 0);
  });
}
const result = (id, value = id, gameId = 'racing') => ({ status: 200, data: { matchId: id, gameId, state: 'open',
  metrics: [{ id: 'official', label: 'Dato de GameStats ' + id, value, unit: 'ms', status: 'provisional', scope: 'match', subjectId: id, basis: { eventCount: 9 } }], patterns: [] } });
const views = ids => new Map(ids.map(id => [id, { frame: {}, gameId: 'racing' }]));
test('shared grid queries are bounded, per-ID deduplicated, selected-match reads join an in-flight query', async () => {
  const clock = new Clock(), calls = [], gates = new Map(), updates = []; let now = 10000;
  const c = new GridResultsCoordinator({ clock, now: () => now, onUpdate: (id, _f, s) => updates.push({ id, ...s }), api: { results: async id => { calls.push(id); const g = deferred(); gates.set(id, g); await g.promise; return result(id); } } });
  const visible = views(['a', 'b', 'c', 'd']); c.setViews(visible, null);
  assert.equal(c.active, 2); assert.deepEqual(calls, ['a', 'b']); c.setViews(visible, null); assert.equal(c.jobs.size, 4);
  const shared = c.fetch('a', 'racing'); gates.get('a').resolve(); await shared; await settle(); assert.equal(calls.filter(id => id === 'a').length, 1);
  assert.equal(c.active, 2); gates.get('b').resolve(); await settle(); gates.get('c').resolve(); gates.get('d').resolve(); await settle();
  for (const id of visible.keys()) assert.equal(updates.filter(s => s.id === id).at(-1).data.matchId, id);
  assert.equal(c.active, 0); assert.equal(clock.jobs.size, 1); now += 5000; await clock.runDelay(5000); assert.equal(c.active, 2);
  c.dispose(); for (const g of gates.values()) g.resolve(); await settle(); assert.equal(clock.jobs.size, 0);
});
test('202, null, invalid/unavailable values and infrastructure failures are preserved with no substitute zeros', async () => {
  const clock = new Clock(), updates = []; let now = 10000, mode = 'valid';
  const c = new GridResultsCoordinator({ clock, now: () => now, onUpdate: (_id, _f, s) => updates.push(s), api: { results: async id => {
    if (mode === 'pending') return { status: 202, data: { status: 'pending' } };
    if (mode === 'error') throw { status: 503, code: 'ANALYTICS_UNAVAILABLE' };
    const r = result(id, null); r.data.metrics[0].status = 'unavailable'; return r;
  } } });
  c.setViews(views(['a']), null); await settle(); assert.equal(updates.at(-1).data.metrics[0].value, null);
  mode = 'error'; now += 5000; await clock.runDelay(5000); assert.equal(updates.at(-1).status, 'failed'); assert.equal(updates.at(-1).error.status, 503); assert.equal(updates.at(-1).data.metrics[0].value, null);
  mode = 'pending'; now += 5000; await clock.runDelay(5000); assert.equal(updates.at(-1).status, 'pending'); assert.equal(updates.at(-1).data, null); c.dispose();
});
test('hidden/unmounted/replaced views discard late publications and cancel queued background reads', async () => {
  const clock = new Clock(), gates = new Map(), updates = [], calls = [];
  const c = new GridResultsCoordinator({ clock, api: { results: async id => { calls.push(id); const g = deferred(); gates.set(id, g); await g.promise; return result(id); } }, onUpdate: (id, frame, state) => updates.push({ id, frame, state }) });
  const initial = views(['a', 'b', 'c']); c.setViews(initial, null); c.setViews(new Map(), null, { hidden: true });
  const before = updates.length; gates.get('a').resolve(); gates.get('b').resolve(); await settle();
  assert.equal(updates.length, before); assert.deepEqual(calls, ['a', 'b']); assert.equal(clock.jobs.size, 0);
  const replacement = views(['a']); c.setViews(replacement, null); await settle();
  const old = replacement.get('a').frame; c.setViews(views(['a']), null); const atReplacement = updates.length;
  gates.get('a').resolve(); await settle(); assert.ok(updates.slice(atReplacement).every(s => s.frame !== old && s.state.status !== 'updated'));
  c.dispose();
});
test('cache is bounded and wrong match/game identities are rejected', async () => {
  let now = 0;
  const c = new GridResultsCoordinator({ clock: new Clock(), now: () => now, cacheLimit: 2, onUpdate() {}, api: { results: async id => result(id) } });
  for (const id of ['a', 'b', 'c']) { await c.fetch(id, 'racing'); now += 1000; }
  assert.deepEqual([...c.cache.keys()], ['b', 'c']);
  c.api.results = async () => result('different'); await assert.rejects(c.fetch('x', 'racing'), { status: 502 });
  c.api.results = async id => result(id, 7, 'different'); await assert.rejects(c.fetch('x', 'racing'), { status: 502 }); c.dispose();
});
test('unrelated workspace updates do not postpone the five-second analytical cadence', async () => {
  const clock = new Clock(); let now = 0, calls = 0;
  const c = new GridResultsCoordinator({ clock, now: () => now, onUpdate() {}, api: { results: async id => { calls++; return result(id); } } });
  const visible = views(['a']); c.setViews(visible, null); await settle();
  now = 3500; c.setViews(visible, null); c.setViews(visible, null);
  assert.equal(calls, 1); assert.equal([...clock.jobs.values()][0].delay, 1500);
  now = 5000; await clock.runDelay(1500); assert.equal(calls, 2); c.dispose();
});
test('a failing summary observer cannot stall other analytical queries or corrupt cached service data', async () => {
  const c = new GridResultsCoordinator({ clock: new Clock(), onUpdate(_id, _f, state) { if (state.data) state.data.metrics[0].value = 'mutated'; throw Error('private UI failure'); }, api: { results: async id => result(id, 89) } });
  c.setViews(views(['a', 'b', 'c']), null); await settle();
  assert.equal(c.active, 0); assert.equal(c.jobs.size, 0); assert.equal(c.cache.get('a').state.data.metrics[0].value, 89); c.dispose();
});

async function consoleHarness(t, locks) {
  const document = new Document(), window = new Window(), bridge = new Bridge(), clock = new Clock(), calls = [];
  if (locks) window.navigator = { locks };
  const matches = ['a', 'b', 'c', 'd'].map(id => snapshot(id, 'racing'));
  const api = { catalog: async () => [plugin('racing')], matches: async () => matches, snapshot: async id => matches.find(s => s.matchId === id), dashboard: async () => ({ status: 200, data: dashboard }),
    results: async id => { calls.push(id); const r = result(id, 'official-' + id); r.data.metrics[0].status = ({ a: 'provisional', b: 'final', c: 'unavailable', d: 'invalid' })[id]; return r; } };
  const presentations = []; bridge.setPresentation = (frame, p) => presentations.push({ frame, ...structuredClone(p) });
  const app = new ConsoleApp({ document, window, bridge, clock, api }); t.after(() => app.dispose()); await app.init();
  for (const s of matches) await app.select(s.matchId);
  await app.results.inFlight; app.setMode('grid'); await settle();
  return { app, document, window, bridge, clock, calls, presentations };
}
test('four Circuitos render independent grid summaries and retain full metric/pattern access without touching frames', async t => {
  const h = await consoleHarness(t), frames = [...h.app.workspace.records.values()].map(r => r.frame);
  for (const [id, r] of h.app.workspace.records) {
    assert.match(r.summary.textContent, new RegExp('official-' + id)); assert.match(r.summary.textContent, /ms/); assert.match(r.summary.textContent, /Más métricas y patrones/);
    assert.ok(r.summary.textContent.includes(({ a: 'En curso', b: 'Final', c: 'No disponible', d: 'Dato inválido' })[id]));
    for (const other of ['a', 'b', 'c', 'd'].filter(x => x !== id)) assert.ok(!r.summary.textContent.includes('official-' + other));
  }
  const selected = h.app.workspace.records.get(h.app.selectedId); selected.analytics.more.open = true;
  await h.app.results.refresh(); assert.equal(selected.analytics.more.open, true);
  const before = h.calls.length; h.app.setMode('focus'); await h.app.results.refresh(); assert.equal(h.app.gridResults.views.size, 0); assert.equal(h.calls.length, before + 1);
  assert.deepEqual([...h.app.workspace.records.values()].map(r => r.frame), frames); assert.equal(h.bridge.unmounts.length, 0);
});
test('host shortcuts focus running visible frames, preserve presentation/control, ignore repeats and editable controls', async t => {
  const h = await consoleHarness(t), records = h.app.workspace.records;
  const event = { key: 'k', ctrlKey: true, altKey: true };
  h.window.fire('keydown', event); assert.equal(h.app.selectedId, 'a'); assert.equal(records.get('a').frame.focusCount, 1);
  assert.match(records.get('a').keyboard.textContent, /Teclado aquí/); assert.ok(records.get('a').card.classes.has('keyboard-target'));
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) h.window.fire('keydown', { ...event, target });
  h.window.fire('keydown', { ...event, repeat: true }); assert.equal(h.app.selectedId, 'a');
  h.window.fire('keydown', { ...event, key: 'j' }); assert.equal(h.app.selectedId, 'd');
  assert.ok(h.presentations.every(p => p.canControl), 'keyboard selection never requests or transfers Web Locks');
  assert.equal(h.bridge.mounts.length, 4); assert.equal(h.bridge.unmounts.length, 0);
  h.app.accept({ ...snapshot('a', 'racing', 1), state: 'finished' });
  h.window.fire('keydown', event); assert.equal(h.app.selectedId, 'b', 'terminal frames are skipped');
  h.app.setSection('library'); h.window.fire('keydown', event); assert.equal(h.app.selectedId, 'b');
});
test('keyboard selection preserves every acquired Web Lock without requesting ownership again', async t => {
  const acquired = [], locks = { request(name, _options, callback) { acquired.push(name); return Promise.resolve().then(() => callback({ name })); } };
  const h = await consoleHarness(t, locks); await settle(); assert.equal(acquired.length, 4);
  assert.ok([...h.app.presentation.records.values()].every(r => r.owner));
  h.window.fire('keydown', { key: 'k', ctrlKey: true, altKey: true }); h.window.fire('keydown', { key: 'j', ctrlKey: true, altKey: true }); await settle();
  assert.equal(acquired.length, 4); assert.ok([...h.app.presentation.records.values()].every(r => r.owner));
  assert.equal(h.bridge.unmounts.length, 0);
});
