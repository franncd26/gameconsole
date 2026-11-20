import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
import { ConsoleError } from '../public/sdk/console-api.mjs';
import { CatalogView, MatchWorkspace, optionControl } from '../public/sdk/console-views.mjs';
import { Document, Window, Bridge, Clock, plugin, snapshot, dashboard, deferred, settle } from './helpers/console-dom.mjs';

function fixture(t, { search = '', matches = [], catalog = [plugin()] } = {}) {
  const document = new Document(), window = new Window(search), bridge = new Bridge(), clock = new Clock();
  const stored = new Map(matches.map(s => [s.matchId, s])), calls = { creates: 0, finishes: 0, reads: [] };
  const api = { catalog: async () => catalog, matches: async () => [...stored.values()], dashboard: async () => ({ status: 200, data: dashboard }),
    results: async id => ({ status: 200, data: { gameId: stored.get(id)?.gameId, matchId: id, state: 'open', metrics: [], patterns: [] } }),
    snapshot: async id => { calls.reads.push(id); if (!stored.has(id)) throw new ConsoleError(404, 'UNKNOWN_MATCH'); return structuredClone(stored.get(id)); },
    create: async id => { calls.creates++; const s = snapshot('new-' + calls.creates, id); stored.set(s.matchId, s); return s; },
    finish: async id => { calls.finishes++; const s = { ...stored.get(id), state: 'finished', version: stored.get(id).version + 1 }; stored.set(id, s); return s; } };
  const app = new ConsoleApp({ document, window, bridge, clock, api }); t.after(() => app.dispose());
  return { app, document, window, bridge, clock, api, stored, calls };
}
test('dynamic option controls preserve declared types/defaults and reject invalid presentation values', () => {
  const d = new Document();
  for (const definition of [{ type: 'boolean', default: true }, { type: 'integer', values: [12,20,28], default: 20 },
    { type: 'integer', min: -3, max: 9, default: 2 }, { type: 'enum', values: ['one','two'], default: 'two' },
    { type: 'string', minLength: 2, maxLength: 5, default: 'ok' }]) {
    const { control, read } = optionControl(d, definition); assert.equal(read(), definition.default);
    if (definition.type !== 'boolean') { control.value = ''; assert.throws(read, { code: 'INVALID_OPTIONS' }); }
  }
  const number = optionControl(d, { type: 'integer', min: 0, max: 3, default: 1 }); number.control.value = '1.5'; assert.throws(number.read);
});
test('catalog renders arbitrary N plugins and single-instance controls offer existing/open/finish without creating', () => {
  const d = new Document(), opens = [], finishes = [], creates = [];
  const view = new CatalogView({ document: d, root: d.getElementById('catalog'), onOpen: id => opens.push(id), onFinish: id => finishes.push(id), onCreate: id => creates.push(id), onError: assert.fail });
  const catalog = Array.from({ length: 6 }, (_, i) => plugin('plugin-' + i)); view.render(catalog); assert.equal(view.cards.size, 6);
  view.setMatches([snapshot('existing', 'plugin-2')]); const card = view.cards.get('plugin-2');
  card.card.children.at(-1).fire('submit'); card.finish.fire('click'); assert.deepEqual(opens, ['existing']); assert.deepEqual(finishes, ['existing']); assert.deepEqual(creates, []);
  assert.match(card.card.textContent, /Descripción del plugin/); view.dispose();
});
test('creation facade admits only one double-click attempt per plugin, then opens confirmed snapshot', async t => {
  const h = fixture(t), gate = deferred(); await h.app.init(); h.api.create = async id => { h.calls.creates++; await gate.promise; const s = snapshot('created', id); h.stored.set(s.matchId, s); return s; };
  const first = h.app.create('alpha', {}), second = h.app.create('alpha', {}); assert.equal(h.calls.creates, 1); gate.resolve(); await Promise.all([first, second]);
  assert.equal(h.app.selectedId, 'created'); assert.equal(h.bridge.mounts.length, 1); assert.equal(h.app.library.cards.get('alpha').busy, false);
});
test('reload recovers server sessions and ?match opens same identity without creating another match', async t => {
  const h = fixture(t, { search: '?match=existing-b', matches: [snapshot('existing-a'), snapshot('existing-b')] }); await h.app.init();
  assert.equal(h.calls.creates, 0); assert.equal(h.app.selectedId, 'existing-b'); assert.equal(h.bridge.mounts.length, 1); assert.equal(h.bridge.mounts[0].snapshot.matchId, 'existing-b'); assert.match(h.window.lastURL, /\?match=existing-b$/);
});
test('unknown ?match reports failure, keeps recovered list and never manufactures a session', async t => {
  const h = fixture(t, { search: '?match=absent', matches: [snapshot()] }); await h.app.init();
  assert.equal(h.calls.creates, 0); assert.equal(h.bridge.mounts.length, 0); assert.equal(h.app.rows.size, 1); assert.match(h.app.notice.textContent, /no está disponible/);
});
test('multiple independent iframes remain identical while selection, stats, list and catalog update', async t => {
  const h = fixture(t, { matches: [snapshot('a'), snapshot('b','beta')], catalog: [plugin(), plugin('beta')] }); await h.app.init(); await settle();
  await h.app.select('a'); await h.app.select('b'); const frames = [...h.app.workspace.records.values()].map(r => r.frame); assert.equal(frames.length, 2);
  h.app.reconcile([...h.stored.values()]); await h.app.dashboard.refresh(); await h.app.results.refresh(); await h.app.loadCatalog(); await h.app.select('a');
  assert.deepEqual([...h.app.workspace.records.values()].map(r => r.frame), frames); assert.equal(h.bridge.unmounts.length, 0);
  const record = h.app.workspace.records.get('a'); h.app.workspace.unmount('a'); await h.app.select('a'); assert.notEqual(record.frame, frames[0]); assert.equal(h.bridge.unmounts.length, 1);
  const mounted = record.frame; record.card.children[4].children.at(-1).fire('click'); await settle();
  assert.notEqual(record.frame, mounted, 'explicit remount always creates a fresh iframe, including a retired channel'); assert.equal(h.bridge.unmounts.length, 2);
});
test('workspace supports N arbitrary plugin views, and multipleInstances true leaves creation available', () => {
  const document = new Document(), bridge = new Bridge();
  const workspace = new MatchWorkspace({ document, root: document.getElementById('workspace'), bridge, onSelect() {}, onFinish() {} });
  for(let i=0;i<6;i++)workspace.open(snapshot('match-'+i,'plugin-'+i),'Plugin '+i);
  assert.equal(workspace.records.size,6);assert.equal(bridge.mounts.length,6);workspace.dispose();assert.equal(bridge.unmounts.length,6);
  const p=plugin('multi');p.capabilities.multipleInstances=true;
  const catalog=new CatalogView({document,root:document.getElementById('catalog'),onCreate(){},onOpen(){},onFinish(){},onError:assert.fail});
  catalog.render([p]);catalog.setMatches([snapshot('one','multi'),snapshot('two','multi')]);assert.equal(catalog.cards.get('multi').existing,null);assert.equal(catalog.cards.get('multi').submit.textContent,'Crear partida');catalog.dispose();
});
test('late selection response cannot open a different identity over the latest selected match', async t => {
  const h = fixture(t, { matches: [snapshot('a'),snapshot('b')] }); await h.app.init(); await settle(); const gate = deferred(), read = h.api.snapshot;
  h.api.snapshot = id => id === 'a' ? gate.promise : read(id);
  const old = h.app.select('a'); await h.app.select('b'); gate.resolve(snapshot('a')); await old;
  assert.equal(h.app.selectedId, 'b'); assert.ok(h.app.workspace.records.get('b').card.classes.has('selected'));
});
test('multipleInstances rejection refreshes SDK and opens the existing session, no automatic create retry', async t => {
  const h = fixture(t); await h.app.init(); h.stored.set('existing', snapshot('existing'));
  h.api.create = async () => { h.calls.creates++; throw new ConsoleError(409, 'MULTIPLE_INSTANCES_DISABLED'); };
  await h.app.create('alpha', {}); assert.equal(h.calls.creates, 1); assert.equal(h.app.selectedId, 'existing'); assert.equal(h.bridge.mounts.length, 1);
});
test('finish refreshes the existing frame without reload and preserves finished card for review', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a'); const frame = h.app.workspace.records.get('a').frame;
  await h.app.finish('a'); assert.equal(h.app.snapshots.get('a').state, 'finished'); assert.equal(h.app.workspace.records.get('a').frame, frame);
  assert.equal(h.bridge.refreshes[0], frame); assert.equal(h.app.workspace.records.get('a').finish.disabled, true); assert.equal(h.bridge.unmounts.length, 0);
});
test('a busy Bridge read cannot permanently hide a confirmed finish: next list update retries on same frame', async t => {
  const h=fixture(t,{matches:[snapshot('a')]});await h.app.init();await h.app.select('a');const record=h.app.workspace.records.get('a'),frame=record.frame;
  let attempts=0;h.bridge.refresh=async()=>++attempts>1;
  const finished=snapshot('a','alpha',1,'finished');h.app.accept(finished);await settle();assert.equal(record.needsRefresh,true);
  h.app.accept(finished);await settle();assert.equal(attempts,2);assert.equal(record.needsRefresh,false);assert.equal(record.frame,frame);assert.equal(h.bridge.unmounts.length,0);
});
test('closing to finished during a pending Bridge read preserves the newer refresh revision on the same iframe', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
  const record = h.app.workspace.records.get('a'), frame = record.frame, gates = [deferred(), deferred()];
  const published = []; let calls = 0, inFlight = 0, maximum = 0;
  h.bridge.refresh = async target => {
    assert.equal(target, frame); const index = calls++, observed = structuredClone(h.stored.get('a'));
    maximum = Math.max(maximum, ++inFlight);
    await gates[index].promise; inFlight--; published.push(observed); return true;
  };
  const closing = snapshot('a', 'alpha', 0, 'closing'); h.stored.set('a', closing); h.app.accept(closing);
  assert.equal(calls, 1);
  const finished = snapshot('a', 'alpha', 1, 'finished'); h.stored.set('a', finished); h.app.accept(finished);
  assert.equal(calls, 1, 'finished cannot overlap the closing read');
  gates[0].resolve(); await settle();
  assert.equal(calls, 2, 'a successful older read must trigger a new read of the current snapshot');
  assert.equal(record.needsRefresh, true);
  gates[1].resolve(); await settle();
  assert.deepEqual(published.map(s => s.state), ['closing', 'finished']);
  assert.ok(published.every(s => s.matchId === 'a' && s.gameId === 'alpha'));
  assert.equal(maximum, 1); assert.equal(record.needsRefresh, false);
  assert.equal(record.frame, frame); assert.equal(h.bridge.unmounts.length, 0);
});
test('reconcile removes disappeared session controls and iframe without finishing it or disturbing another session', async t => {
  const h = fixture(t, { matches: [snapshot('a'), snapshot('b', 'beta')], catalog: [plugin(), plugin('beta')] });
  await h.app.init(); await h.app.select('a'); await h.app.select('b'); await h.app.select('a');
  const missing = h.app.workspace.records.get('a'), missingFrame = missing.frame, survivor = h.app.workspace.records.get('b'), frame = survivor.frame;
  h.stored.delete('a'); h.app.reconcile([...h.stored.values()]); await settle();
  assert.equal(h.app.workspace.records.has('a'), false); assert.equal(missing.card.parentNode, null);
  assert.equal(h.app.rows.has('a'), false); assert.equal(h.app.snapshots.has('a'), false);
  assert.deepEqual(h.bridge.unmounts, [missingFrame]);
  await h.app.finish('a'); missing.finish.fire('click'); await settle();
  assert.equal(h.calls.finishes, 0, 'even a stale callback cannot finalize an ID removed by reconciliation');
  assert.equal(h.app.library.cards.get('alpha').existing, null);
  assert.equal(h.app.workspace.records.get('b'), survivor); assert.equal(survivor.frame, frame);
});
test('persistent false/rejected refresh keeps pending work but never retries without a later update', async t => {
  for (const rejects of [false, true]) {
    const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
    const record = h.app.workspace.records.get('a'), gate = deferred(); let calls = 0;
    h.bridge.refresh = async () => { if (++calls === 1) await gate.promise; if (rejects) throw Error('/private/transport'); return false; };
    h.app.accept(snapshot('a', 'alpha', 0, 'closing')); h.app.accept(snapshot('a', 'alpha', 1, 'finished'));
    gate.resolve(); await settle();
    assert.equal(calls, 1); assert.equal(record.needsRefresh, true); assert.equal(record.refreshing, false);
    assert.ok(!record.channel.textContent.includes('/private'));
    await settle(); assert.equal(calls, 1, 'failure cannot trigger an immediate retry loop');
    h.app.accept(snapshot('a', 'alpha', 1, 'finished')); await settle();
    assert.equal(calls, 2); assert.equal(record.needsRefresh, true); assert.equal(record.refreshing, false);
  }
});
test('unmount invalidates old refresh success/failure without releasing the new iframe read guard', async t => {
  for (const rejects of [false, true]) {
    const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
    const record = h.app.workspace.records.get('a'), oldFrame = record.frame, gates = [deferred(), deferred()], frames = [];
    h.bridge.refresh = async frame => {
      const index = frames.length; frames.push(frame); await gates[index].promise;
      if (index === 0 && rejects) throw Error('old private failure'); return true;
    };
    const closing = snapshot('a', 'alpha', 0, 'closing'); h.app.accept(closing);
    h.app.workspace.unmount('a'); h.app.workspace.open(closing, 'Nombre alpha'); const freshFrame = record.frame;
    h.app.accept(snapshot('a', 'alpha', 1, 'finished'));
    assert.notEqual(freshFrame, oldFrame); assert.deepEqual(frames, [oldFrame, freshFrame]);
    gates[0].resolve(); await settle();
    assert.equal(record.refreshing, true, 'late old finally must not release the fresh generation guard');
    assert.equal(record.needsRefresh, true);
    h.app.accept(snapshot('a', 'alpha', 1, 'finished')); assert.equal(frames.length, 2);
    gates[1].resolve(); await settle(); assert.equal(record.refreshing, false); assert.equal(record.needsRefresh, false);
    assert.equal(record.frame, freshFrame);
  }
});
test('workspace rejects a different game identity for an already mounted match', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
  const record = h.app.workspace.records.get('a'), frame = record.frame;
  h.app.workspace.upsert(snapshot('a', 'foreign-plugin', 99, 'finished'), 'Foreign'); await settle();
  assert.equal(record.snapshot.gameId, 'alpha'); assert.equal(record.snapshot.state, 'running');
  assert.equal(record.frame, frame); assert.equal(h.bridge.refreshes.length, 0);
});
test('disappeared selected session cancels result polling and invalidates a delayed selection response', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
  const gate = deferred(); h.api.snapshot = () => gate.promise;
  const selection = h.app.select('a'); h.stored.clear(); h.app.reconcile([]);
  assert.equal(h.app.selectedId, null); assert.equal(h.app.results.key, null);
  assert.equal(h.window.lastURL, '/'); assert.match(h.document.getElementById('selected-title').textContent, /no disponible/);
  gate.resolve(snapshot('a')); await selection;
  assert.equal(h.app.workspace.records.size, 0); assert.equal(h.app.rows.size, 0); assert.equal(h.bridge.mounts.length, 1);
});
test('a finish response arriving after the session disappears cannot resurrect its controls or restart results', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
  const gate = deferred(); h.api.finish = async () => { h.calls.finishes++; return gate.promise; };
  const closing = h.app.finish('a'); h.stored.clear(); h.app.reconcile([]);
  gate.resolve(snapshot('a', 'alpha', 1, 'finished')); await closing;
  await h.app.finish('a'); assert.equal(h.calls.finishes, 1, 'only the request started before disappearance was sent');
  assert.equal(h.app.snapshots.size, 0); assert.equal(h.app.workspace.records.size, 0); assert.equal(h.app.results.key, null);
});
test('lost finish response reads confirmed closing, permits explicit retry and never retries automatically', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
  h.api.finish = async id => { h.calls.finishes++; if (h.calls.finishes === 1) { h.stored.set(id, snapshot(id, 'alpha', 0, 'closing')); throw new ConsoleError(0); } const s = snapshot(id, 'alpha', 1, 'finished'); h.stored.set(id,s); return s; };
  await h.app.finish('a'); assert.equal(h.calls.finishes,1); assert.equal(h.app.snapshots.get('a').state,'closing'); assert.equal(h.app.workspace.records.get('a').finish.textContent,'Reintentar cierre');
  await h.app.finish('a'); assert.equal(h.calls.finishes,2); assert.equal(h.app.snapshots.get('a').state,'finished');
});
test('analytics outage never unmounts games; hidden/pagehide stop polls and clean all resources', async t => {
  const h = fixture(t, { matches: [snapshot('a')] }); await h.app.init(); await h.app.select('a');
  await h.app.results.inFlight; h.api.results = async () => { throw new ConsoleError(503); }; await h.app.results.refresh(); assert.equal(h.bridge.unmounts.length,0); assert.match(h.document.getElementById('result-status').textContent,/503/);
  h.document.hidden = true; h.document.fire('visibilitychange'); assert.equal(h.clock.jobs.size,0); h.window.fire('pagehide'); assert.equal(h.bridge.disposed,true); assert.equal(h.bridge.unmounts.length,1); assert.equal(h.clock.jobs.size,0);
});
