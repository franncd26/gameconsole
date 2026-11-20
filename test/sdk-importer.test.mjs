import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { PluginImporter } from '../server/sdk/importer/service.mjs';
import { archive } from '../server/sdk/importer/archive.mjs';
import { ScalaActivator, analysisProbe, profilesDigest } from '../server/sdk/importer/analytics.mjs';
import { seedProfiles } from '../scripts/deploy-importer.mjs';
import { HostBridge } from '../public/sdk/bridge/host-bridge.mjs';
import { createGameBridgeClient } from '../public/sdk/bridge/game-client.mjs';
import { windows, settle } from './helpers/bridge.mjs';
const plugins = fileURLToPath(new URL('../plugins/', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/import-demo/', import.meta.url));
const ids = ['tic-tac-toe','snake','racing'];
async function setup(t, fail = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-import-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = path.join(root, 'profiles'); await mkdir(profiles);
  for (const id of ids) await cp(path.join(plugins, id, 'analytics/profile.json'), path.join(profiles, id + '.json'));
  const baseline = await Promise.all(ids.map(id => readFile(path.join(profiles, id + '.json'))));
  const sdk = await prepareSDK({ pluginsDirectory: plugins, trustedIds: ids });
  const checks = [], activator = { async verify(p) { checks.push(p.gameId); assert.equal(JSON.parse(await readFile(path.join(profiles, p.gameId + '.json'))).gameId, p.gameId); if (fail && p.gameId === 'import-demo') throw Object.assign(Error('private path'), { code: 'ANALYTICS_ACTIVATION_FAILED', status: 503 }); } };
  const options = { storage: path.join(root, 'data'), profiles, activator };
  const importer = new PluginImporter(sdk, options); await importer.initialize(); sdk.enableImporter(importer);
  const zip = path.join(root, 'demo.game.zip'); await archive('pack', fixture, zip);
  return { root, sdk, importer, options, checks, baseline, zip, profiles };
}
async function http(t, h) {
  const events = [], app = createApp({ sdk: h.sdk, statsURL: 'http://go.test', statsFetcher: async (url, init) => {
    if (new URL(url).pathname === '/events') { events.push(JSON.parse(init.body)); return Response.json({}, { status: 201 }); }
    throw Error('Unexpected test request');
  } });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { app.outbox.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { Origin: base, 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json', ...headers }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, events, request, base };
}
test('actual ZIP preview does not execute Node; dynamic import preserves manager, sessions, Outbox, assets and Bridge', async t => {
  const h = await setup(t), web = await http(t, h), manager = web.app.sdk.manager;
  const existing = await manager.create('snake'); await manager.activate(existing.matchId);
  assert.equal((await web.request('/api/sdk/catalog')).body.length, 3);
  const preview = await web.request('/api/sdk/plugins/import/preview', await readFile(h.zip)); assert.equal(preview.status, 200); assert.equal(h.checks.length, 0);
  assert.equal(preview.body.manifest.id, 'import-demo');
  const installed = await web.request('/api/sdk/plugins/import', { token: preview.body.token }); assert.equal(installed.status, 201); assert.equal(installed.body.analytics, 'verified');
  assert.equal(web.app.sdk.manager, manager); assert.equal((await manager.getSnapshot(existing.matchId)).state, 'running');
  assert.equal((await web.request('/api/sdk/catalog')).body.length, 4);
  const create = () => web.request('/api/sdk/matches', { gameId: 'import-demo' });
  const [a, b] = await Promise.all([create(), create()]); assert.equal(a.status, 201); assert.equal(b.status, 201); assert.notEqual(a.body.matchId, b.body.matchId);
  const pair = windows(), host = new HostBridge({ window: pair.host, fetcher: (url, init) => fetch(web.base + url, init) });
  host.attach(pair.frame, a.body, { loaded: true }); const bridge = createGameBridgeClient({ window: pair.game, hostOrigin: 'http://console.test' });
  t.after(() => { bridge.dispose(); host.dispose(); }); await settle();
  await new Promise(resolve => { const off = bridge.onInit(() => { queueMicrotask(() => off()); resolve(); }); });
  const result = await bridge.dispatch('INCREMENT', {}, { messageId: 'once' }); assert.equal(result.snapshot.data.count, 1);
  await host.waitForIdle(pair.frame);
  assert.equal((await bridge.dispatch('INCREMENT', {}, { messageId: 'once' })).snapshot.data.count, 1);
  assert.equal((await manager.getSnapshot(b.body.matchId)).data.count, 0);
  await bridge.dispatch('COMPLETE', {}); await manager.finish(a.body.matchId); await web.app.outbox.flush(1000);
  assert.equal(web.events.filter(e => e.matchId === a.body.matchId && e.type === 'COUNTER_INCREMENTED').length, 1);
  assert.equal(web.events.filter(e => e.matchId === a.body.matchId && e.type === 'MATCH_FINISHED').length, 1);
  const asset = await fetch(web.base + '/sdk/web/import-demo/app.mjs'); assert.equal(asset.status, 200); assert.match(await asset.text(), /createGameBridgeClient/);
  assert.equal((await fetch(web.base + '/sdk/web/import-demo/')).status, 200);
  const restarted = await prepareSDK({ pluginsDirectory: plugins, trustedIds: ids });
  const recovered = new PluginImporter(restarted, h.options); await recovered.initialize(); restarted.enableImporter(recovered);
  const app2 = createApp({ sdk: restarted, statsFetcher: async () => Response.json({}) }); app2.outbox.stop();
  assert.equal(app2.sdk.catalog().length, 4); assert.equal(app2.sdk.manager.size, 0, 'no session persistence');
  assert.deepEqual(recovered.issues, []);
});
test('bad manifest/profile/module/session and corrupt ZIP never activate or replace academics', async t => {
  const h = await setup(t);
  await assert.rejects(h.importer.preview(Buffer.from('not zip')));
  for (const kind of ['manifest','profile','module','session','state']) {
    const copy = path.join(h.root, kind); await cp(fixture, copy, { recursive: true });
    if (kind === 'manifest') { const m = JSON.parse(await readFile(path.join(copy, 'game.json'))); m.sdkVersion = '9'; await writeFile(path.join(copy, 'game.json'), JSON.stringify(m)); }
    if (kind === 'profile') { const p = JSON.parse(await readFile(path.join(copy, 'analytics/profile.json'))); p.gameId = 'other'; await writeFile(path.join(copy, 'analytics/profile.json'), JSON.stringify(p)); }
    if (kind === 'module') await writeFile(path.join(copy, 'server/index.mjs'), 'throw Error("module must not execute during preview"); export default {};');
    if (kind === 'session') await writeFile(path.join(copy, 'server/index.mjs'), `export default {initializationContract:{participants:[{id:'human',role:'human',required:true}],startData:{}},createSession(){return {startData:{},session:{finish(){}}};}}`);
    if (kind === 'state') await writeFile(path.join(copy, 'server/index.mjs'), `export default {initializationContract:{participants:[{id:'human',role:'human',required:true}],startData:{}},createSession(){return {startData:{},session:{getSnapshot(){return {count:0}},dispatch(){return {outcome:'completed'}},finish(){}}};}}`);
    const zip = path.join(h.root, kind + '.zip'); await archive('pack', copy, zip);
    if (['module','session','state'].includes(kind)) { const p = await h.importer.preview(await readFile(zip)); await assert.rejects(h.importer.install(p.token)); }
    else await assert.rejects(h.importer.preview(await readFile(zip)));
    assert.equal(h.sdk.has('import-demo'), false); assert.equal((await readdir(h.profiles)).length, 3);
  }
});
test('concurrent installs serialize, reject duplicate ID, keep the first receipt and original profiles byte-for-byte', async t => {
  const h = await setup(t), bytes = await readFile(h.zip);
  const [a, b] = await Promise.all([h.importer.preview(bytes), h.importer.preview(bytes)]);
  const outcomes = await Promise.allSettled([h.importer.install(a.token), h.importer.install(b.token)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1); assert.equal(outcomes.find(o => o.status === 'rejected').reason.code, 'DUPLICATE_ID');
  await access(path.join(h.options.storage, 'enabled/import-demo.json'));
  for (const [i, id] of ids.entries()) assert.deepEqual(await readFile(path.join(h.profiles, id + '.json')), h.baseline[i]);
  assert.deepEqual(await readdir(path.join(h.options.storage, 'staging')), []);
});
test('analytical rejection rolls back files, verifies recovery, and leaves the catalog unchanged', async t => {
  const h = await setup(t, true), p = await h.importer.preview(await readFile(h.zip));
  await assert.rejects(h.importer.install(p.token), { code: 'ANALYTICS_ACTIVATION_FAILED' });
  assert.equal(h.sdk.has('import-demo'), false); assert.equal((await readdir(h.profiles)).length, 3); assert.ok(h.checks.length >= 2);
  assert.deepEqual(await readdir(path.join(h.options.storage, 'packages')), []); assert.deepEqual(await readdir(path.join(h.options.storage, 'enabled')), []);
});
test('two different concurrent installs serialize analytics and both remain authorized', async t => {
  const h = await setup(t), copy = path.join(h.root, 'second'); await cp(fixture, copy, { recursive: true });
  const m = JSON.parse(await readFile(path.join(copy, 'game.json'))); m.id = 'import-demo-two'; await writeFile(path.join(copy, 'game.json'), JSON.stringify(m));
  const p = JSON.parse(await readFile(path.join(copy, 'analytics/profile.json'))); p.gameId = m.id; await writeFile(path.join(copy, 'analytics/profile.json'), JSON.stringify(p));
  const zip = path.join(h.root, 'second.zip'); await archive('pack', copy, zip);
  let active = 0, max = 0; const original = h.options.activator.verify;
  h.options.activator.verify = async profile => { active++; max = Math.max(active, max); await new Promise(r => setImmediate(r)); await original(profile); active--; };
  const [a, b] = await Promise.all([h.importer.preview(await readFile(h.zip)), h.importer.preview(await readFile(zip))]);
  await Promise.all([h.importer.install(a.token), h.importer.install(b.token)]);
  assert.equal(max, 1); assert.equal(h.sdk.has('import-demo'), true); assert.equal(h.sdk.has(m.id), true);
});
test('recovery rejects an invalid persisted profile without removing academic packages or profiles', async t => {
  const h = await setup(t), p = await h.importer.preview(await readFile(h.zip)); await h.importer.install(p.token);
  await writeFile(path.join(h.options.storage, 'packages/import-demo/analytics/profile.json'), '{}');
  const sdk = await prepareSDK({ pluginsDirectory: plugins, trustedIds: ids }), importer = new PluginImporter(sdk, h.options); await importer.initialize();
  assert.equal(sdk.has('import-demo'), false); assert.equal(importer.issues[0].code, 'RECOVERY_REJECTED');
  assert.equal((await readdir(h.profiles)).length, 3); for (const id of ids) assert.equal(sdk.has(id), true);
});
test('origin, opt-in, body/method restrictions and academic catalog remain separate', async t => {
  const h = await setup(t), web = await http(t, h);
  const denied = await web.request('/api/sdk/plugins/import/preview', await readFile(h.zip), { Origin: 'http://foreign.test' }); assert.equal(denied.status, 403);
  const wrong = await fetch(web.base + '/api/sdk/plugins/import/preview', { method: 'DELETE' }); assert.equal(wrong.status, 405);
  const large = await web.request('/api/sdk/plugins/import/preview', Buffer.alloc(10 * 1024 * 1024 + 1)); assert.equal(large.status, 413);
  const academic = await prepareSDK({ pluginsDirectory: plugins, trustedIds: ids });
  const other = await http(t, { sdk: academic }); assert.equal((await other.request('/api/sdk/plugins/import')).body.enabled, false);
  assert.equal((await other.request('/api/sdk/plugins/import', { token: 'x' })).status, 404); assert.equal((await other.request('/api/sdk/catalog')).body.length, 3);
});
test('ZIP stdlib rejects traversal, case-duplicate entries, symlinks and expanded oversized files', async t => {
  const h = await setup(t);
  const run = promisify(execFile), python = process.platform === 'win32' ? 'py' : 'python3', prefix = process.platform === 'win32' ? ['-3'] : [];
  for (const kind of ['traversal','duplicate','symlink','oversize']) {
    const zip = path.join(h.root, kind + '.zip');
    const code = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED)\nz.writestr('demo/game.json','{}')\nk=sys.argv[2]\nif k=='traversal': z.writestr('demo/../escape','bad')\nif k=='duplicate': z.writestr('demo/GAME.json','{}')\nif k=='symlink':\n i=zipfile.ZipInfo('demo/link');i.create_system=3;i.external_attr=0o120777<<16;z.writestr(i,'/tmp')\nif k=='oversize': z.writestr('demo/large',b'a'*(4*1024*1024+1))\nz.close()`;
    await run(python, [...prefix, '-I', '-c', code, zip, kind], { windowsHide: true });
    await assert.rejects(h.importer.preview(await readFile(zip)), { code: 'INVALID_ARCHIVE' });
  }
});
test('Scala verification requires declared metric/source/basis; health or empty arrays are not enough', async () => {
  const profile = JSON.parse(await readFile(path.join(fixture, 'analytics/profile.json'))); let calls = 0;
  const activator = new ScalaActivator('http://scala.test', { timeoutMs: 50, intervalMs: 0, sleep: async () => {}, fetcher: async (url, init) => {
    assert.ok(url.endsWith('/analyze')); calls++; const input = JSON.parse(init.body);
    return Response.json({ gameId: input.gameId, matchId: input.matchId, state: 'closed', metrics: calls < 2 ? [] : [{ id: 'increments.match', value: 1, status: 'final', source: { templateId: 'event-metrics/v1', instanceId: 'counter', profileVersion: '1.0.0' }, basis: { eventCount: input.events.length } }] });
  } }); await activator.verify(profile); assert.equal(calls, 2);
  const probe = analysisProbe(profile); assert.equal(probe.snapshot.events[0].type, 'MATCH_STARTED'); assert.equal(probe.snapshot.events.at(-1).type, 'MATCH_FINISHED');
  await assert.rejects(new ScalaActivator('http://scala.test', { timeoutMs: 1, intervalMs: 0, sleep: async () => {}, fetcher: async () => Response.json({ metrics: [] }) }).verify(profile), { code: 'ANALYTICS_ACTIVATION_FAILED' });
});
test('profile seeding preserves installed extras and refuses modified originals without overwriting them', async t => {
  const h = await setup(t), target = path.join(h.root, 'seed');
  await seedProfiles(h.profiles, target); await writeFile(path.join(target, 'extra.json'), '{}'); await seedProfiles(h.profiles, target);
  assert.equal((await readdir(target)).length, 4); await writeFile(path.join(target, 'racing.json'), 'modified');
  await assert.rejects(seedProfiles(h.profiles, target)); assert.equal(await readFile(path.join(target, 'racing.json'), 'utf8'), 'modified');
});
test('activation waits for the supervisor fingerprint even if an older engine could return the same metric/version', async t => {
  const h = await setup(t), state = path.join(h.root, 'control'); await mkdir(state);
  const old = await profilesDigest(h.profiles); await writeFile(path.join(state, 'loaded'), old);
  const profile = JSON.parse(await readFile(path.join(fixture, 'analytics/profile.json'))); await writeFile(path.join(h.profiles, 'import-demo.json'), JSON.stringify(profile));
  const expected = await profilesDigest(h.profiles); assert.notEqual(expected, old); let calls = 0, waits = 0;
  const a = new ScalaActivator('http://scala.test', { profilesDirectory: h.profiles, stateDirectory: state, timeoutMs: 1000, intervalMs: 1,
    sleep: async () => { assert.equal(calls, 0); waits++; await writeFile(path.join(state, 'loaded'), expected); },
    fetcher: async (_url, init) => { calls++; const s = JSON.parse(init.body); return Response.json({ gameId: s.gameId, matchId: s.matchId, state: 'closed', metrics: [{ id: 'increments.match', value: 1, status: 'final', source: { templateId: 'event-metrics/v1', instanceId: 'counter', profileVersion: '1.0.0' }, basis: { eventCount: s.events.length } }] }); } });
  await a.verify(profile); assert.equal(waits, 1); assert.equal(calls, 1);
});
test('startup removes only its uncommitted journaled publication after a crash', async t => {
  const h = await setup(t), bytes = await readFile(path.join(fixture, 'analytics/profile.json'));
  await cp(fixture, path.join(h.options.storage, 'packages/import-demo'), { recursive: true });
  await writeFile(path.join(h.profiles, 'import-demo.json'), bytes);
  await writeFile(path.join(h.options.storage, 'transactions/import-demo.json'), JSON.stringify({ id: 'import-demo', profileHash: createHash('sha256').update(bytes).digest('hex') }));
  const sdk = await prepareSDK({ pluginsDirectory: plugins, trustedIds: ids }); await new PluginImporter(sdk, h.options).initialize();
  assert.equal(sdk.has('import-demo'), false); assert.equal((await readdir(h.profiles)).length, 3); assert.deepEqual(await readdir(path.join(h.options.storage, 'packages')), []);
});
