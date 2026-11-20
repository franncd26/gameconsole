import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { syntaxFiles } from '../scripts/check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');
test('Docker runtime inputs relocate the actual three packages; private Prolog/web/profiles are present without running services', async t => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /FROM node:22-/); assert.match(dockerfile, /swi-prolog-nox/);
  assert.match(dockerfile, /^USER node$/m); assert.match(dockerfile, /HEALTHCHECK.*\/api\/health/);
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/m);
  const copies = [...dockerfile.matchAll(/^COPY --chown=node:node (\S+) \.\/(.*)$/gm)];
  assert.deepEqual(copies.map(m => m[1]).sort(), ['package.json','plugins','prolog','public','server']);
  const image = await mkdtemp(path.join(os.tmpdir(), 'sdk-image-layout-'));
  t.after(() => rm(image, { recursive: true, force: true }));
  for (const [, source, target] of copies) await cp(path.join(root, source), target ? path.join(image, target.trim()) : path.join(image, source), { recursive: true });
  assert.deepEqual((await readdir(path.join(image, 'plugins'))).sort(), ['racing','snake','tic-tac-toe']);
  const { prepareSDK } = await import(pathToFileURL(path.join(image, 'server/sdk/bootstrap.mjs')));
  const { EventOutbox } = await import(pathToFileURL(path.join(image, 'server/outbox.mjs')));
  const sdk = await prepareSDK({ pluginsDirectory: path.join(image, 'plugins'), trustedIds: ['tic-tac-toe','snake','racing'] });
  let sends = 0;
  const outbox = new EventOutbox('http://unused.test', { fetcher: async () => { sends++; throw Error('No transport should run'); } });t.after(()=>outbox.stop());
  const runtime = sdk.connect(outbox);
  assert.deepEqual(runtime.catalog().map(p=>p.id), ['racing','snake','tic-tac-toe']);
  for (const id of ['tic-tac-toe','snake','racing']) {
    const pkg = runtime.webPackage(id); await access(pkg.paths.web); await access(pkg.paths.profile);
    const snapshot = await runtime.manager.create(id); assert.equal(snapshot.state, 'prepared'); await runtime.manager.discard(snapshot.matchId);
  }
  const adapter = pathToFileURL(path.join(image, 'plugins/tic-tac-toe/server/prolog-adapter.mjs'));
  const privateProgram = fileURLToPath(new URL('../prolog/gato.pl', adapter));
  assert.equal(privateProgram, path.join(image, 'plugins/tic-tac-toe/prolog/gato.pl'));
  assert.match(await readFile(adapter, 'utf8'), /new URL\('\.\.\/prolog\/gato\.pl', import\.meta\.url\)/);
  await access(privateProgram); assert.equal(sends, 0);
});
test('Compose statically configures only three services, trusted SDK/DNS and existing hardening without fixed public origin', async () => {
  const compose = await read('compose.yaml');
  assert.deepEqual([...compose.matchAll(/^  ([a-z-]+):$/gm)].map(m=>m[1]), ['scala-analysis','go-ingestion','gameconsole']);
  const consoleBlock = compose.split('  gameconsole:')[1];
  for (const text of ['GAMECONSOLE_SDK_ENABLED: "1"','GAMECONSOLE_PLUGINS_DIR: /app/plugins', 'GAMECONSOLE_TRUSTED_IDS: tic-tac-toe,snake,racing','GAMESTATS_URL: http://go-ingestion:8080']) assert.ok(consoleBlock.includes('      '+text));
  assert.ok(!consoleBlock.includes('GAMECONSOLE_PUBLIC_ORIGIN'));
  assert.equal((compose.match(/read_only: true/g)||[]).length,3);assert.equal((compose.match(/cap_drop: \[ALL\]/g)||[]).length,3);
  assert.equal((compose.match(/no-new-privileges:true/g)||[]).length,3);
  assert.doesNotMatch(compose.split('  go-ingestion:')[0], /^\s+ports:/m);
  assert.match(compose, /SCALA_PROFILES_DIR: \/app\/profiles/);assert.match(compose, /127\.0\.0\.1:\$\{PORT:-3000\}/);
});
test('runtime whitelist excludes external repositories, secrets, caches, dependencies and evidence', async () => {
  const ignore = (await read('.dockerignore')).split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
  assert.equal(ignore[0], '**');
  for (const tree of ['server','public','plugins','prolog']) assert.ok(ignore.includes('!'+tree+'/**'));
  for (const pattern of ['**/.git','**/.deps','**/.env','**/.env.*','**/*.key','**/node_modules','**/evidence','**/.cache']) assert.ok(ignore.includes(pattern),pattern);
});
test('CI limits heavy integration to main/manual and runs it once, with evidence/logs and always cleanup', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /push:\s+branches: \[main\]/);assert.match(workflow, /workflow_dispatch:/);
  const [verify, integrated] = workflow.split('  integrated:');
  assert.match(verify, /node-version: "22"/);assert.match(verify, /run: npm test/);assert.match(verify, /plugins\/tic-tac-toe\/prolog\/gato_tests.pl/);assert.doesNotMatch(verify, /docker compose/);
  assert.match(integrated, /if: github.event_name == 'push' \|\| \(github.event_name == 'workflow_dispatch' && github.event.inputs.integration != 'false'\)/);
  assert.equal((integrated.match(/run: npm run test:integration:sdk/g)||[]).length,1);
  assert.doesNotMatch(integrated, /run: npm run test:integration\s|scripts\/recovery.mjs/);
  for (const text of ['scripts/prepare.mjs','docker compose config --quiet','docker compose build','--wait --wait-timeout 180','evidence/sdk-integration.json','logs --no-color --tail=100','if: always()','run: docker compose down']) assert.ok(integrated.includes(text),text);
  assert.match(integrated, /COMPOSE_PROJECT_NAME: gameconsole-ci-/);
});
test('portable syntax inventory covers SDK, host/browser, plugins and scripts without importing/executing modules', async () => {
  const files = await syntaxFiles();
  for(const relative of ['server/sdk/bootstrap.mjs','public/sdk/console.mjs','plugins/tic-tac-toe/server/index.mjs','plugins/snake/web/app.mjs','plugins/racing/server/index.mjs','scripts/sdk-compose-integration.mjs']) assert.ok(files.includes(path.join(root,relative)));
  assert.ok(files.every(file=>!file.includes(path.sep+'.deps'+path.sep)));
  const pkg=JSON.parse(await read('package.json'));assert.equal(pkg.scripts.check,'node scripts/check.mjs');assert.equal(pkg.scripts['test:integration:sdk'],'node scripts/sdk-compose-integration.mjs');assert.equal(pkg.scripts['test:integration'],'node scripts/integration.mjs');
  assert.equal(JSON.parse(await read('gamestats.lock.json')).ref,'4adee854ea3b35148b1eadd0549d4d8e647b345c');
});
