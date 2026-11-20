import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PluginImportView } from '../public/sdk/console-import.mjs';
import { Document, Window, Bridge, Clock, plugin, snapshot, dashboard, deferred, settle } from './helpers/console-dom.mjs';
import { ConsoleApp } from '../public/sdk/console-app.mjs';
test('import UI previews metadata, requires confirmation, prevents duplicate submits and refreshes catalog without reloading frames', async () => {
  const document = new Document(), gate = deferred(); let previews = 0, installs = 0, catalogs = 0;
  const api = { importStatus: async () => ({ enabled: true }), previewPlugin: async () => { previews++; return { token: 'token', manifest: { name: '<b>Un juego</b>', version: '1.0.0', description: 'Descripción' } }; },
    installPlugin: async token => { assert.equal(token, 'token'); installs++; await gate.promise; } };
  const view = new PluginImportView({ document, api, onInstalled: async () => { catalogs++; } }); await view.init();
  assert.equal(document.getElementById('import-game').hidden, false); document.getElementById('import-file').files = [{ name: 'example.game.zip', size: 12 }];
  await view.preview(); assert.equal(previews, 1); assert.equal(installs, 0); assert.match(document.getElementById('import-details').textContent, /<b>Un juego<\/b>/);
  const first = view.confirm(); await view.confirm(); assert.equal(installs, 1); gate.resolve(); await first;
  assert.equal(catalogs, 1); assert.match(document.getElementById('import-status').textContent, /verificado/); view.dispose();
});
test('UI rejects wrong extension and renders installation failure without automatic retry', async () => {
  const document = new Document(); let count = 0;
  const view = new PluginImportView({ document, api: { previewPlugin: async () => { throw Error(); }, installPlugin: async () => { count++; throw Error('Scala no confirmó el perfil'); } }, onInstalled() { assert.fail(); } });
  document.getElementById('import-file').files = [{ name: 'x.jar', size: 10 }]; await view.preview(); assert.match(document.getElementById('import-status').textContent, /game.zip/);
  view.token = 'pending'; await view.confirm(); assert.equal(count, 1); assert.match(document.getElementById('import-status').textContent, /Scala/); view.dispose();
});
test('experimental compose preserves three services, loopback ports, no Docker socket and a Java-only supervisor', async () => {
  const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
  const compose = await read('compose.importer.yaml'); assert.deepEqual([...compose.matchAll(/^  ([a-z-]+):$/gm)].map(m => m[1]), ['scala-analysis','go-ingestion','gameconsole']);
  assert.match(compose, /GAMECONSOLE_IMPORT_ENABLED: "1"/); assert.match(compose, /127\.0\.0\.1/); assert.doesNotMatch(compose, /docker\.sock|privileged:/);
  const supervisor = await read('deployment/importer/scala-supervisor.sh'); assert.match(supervisor, /gamestats.Main/); assert.match(supervisor, /restoring last healthy set/); assert.doesNotMatch(supervisor, /docker|go-ingestion|node /);
  assert.match(await read('deployment/importer/Dockerfile.scala'), /FROM gameconsole-gamestats-scala:local/);
  assert.doesNotMatch(await read('compose.yaml'), /GAMECONSOLE_IMPORT_ENABLED/);
});
test('an import confirmed during an older catalog read schedules a fresh catalog without remounting live sessions', async t => {
  const document = new Document(), window = new Window(), bridge = new Bridge(), clock = new Clock(), gate = deferred(); let mode = 'initial';
  const s = snapshot(), api = { catalog: async () => { if (mode === 'old') { await gate.promise; return [plugin()]; } return mode === 'new' ? [plugin(), plugin('imported')] : [plugin()]; },
    matches: async () => [s], snapshot: async () => s, results: async () => ({ status: 200, data: { gameId: 'alpha', matchId: s.matchId, state: 'open', metrics: [], patterns: [] } }), dashboard: async () => ({ status: 200, data: dashboard }) };
  const app = new ConsoleApp({ document, window, bridge, clock, api }); t.after(() => app.dispose()); await app.init(); const frame = app.workspace.records.get(s.matchId).frame;
  mode = 'old'; const old = app.loadCatalog(); await settle(); mode = 'new'; await app.importView.onInstalled(); gate.resolve(); await old; await settle();
  assert.equal(app.catalog.has('imported'), true); assert.equal(app.workspace.records.get(s.matchId).frame, frame); assert.equal(bridge.unmounts.length, 0);
});
