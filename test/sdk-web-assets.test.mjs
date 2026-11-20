import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareSDK } from '../server/sdk/bootstrap.mjs';
import { createApp } from '../server/index.mjs';
import { createWebAssets } from '../server/sdk/web-assets.mjs';

async function setup(t, enabled = true, publicOrigin) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sdk-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'snake');
  await cp(new URL('../plugins/snake/', import.meta.url), dir, { recursive: true });
  await cp(dir, path.join(root, 'untrusted'), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'untrusted/game.json')));
  manifest.id = 'untrusted'; await writeFile(path.join(root, 'untrusted/game.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'untrusted/server/index.mjs'), "throw Error('must never import untrusted web');");
  await writeFile(path.join(dir, 'web/local.mjs'), "export const value = 1;\n");
  await writeFile(path.join(dir, 'web/local.css'), 'body { color: navy; }\n');
  const sdk = enabled ? await prepareSDK({ pluginsDirectory: root, trustedIds: ['snake'] }) : undefined;
  const app = createApp({ sdk, publicOrigin, statsURL: 'http://go.test', statsFetcher: async () => new Response('{}') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.outbox.stop(); app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); });
  const port = app.server.address().port;
  const request = (raw, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: raw, method, headers }, (res) => {
      const chunks = []; res.on('data', (b) => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
  return { dir, root, app, request };
}
test('disabled SDK and unknown/untrusted plugins never expose web resources', async (t) => {
  const disabled = await setup(t, false); assert.equal((await disabled.request('/sdk/web/snake/')).status, 404);
  const h = await setup(t);
  for (const id of ['missing', 'untrusted']) assert.equal((await h.request(`/sdk/web/${id}/`)).status, 404);
});
test('trusted HTML/CSS/ESM headers, GET/HEAD, separate CSP and static-only CORS', async (t) => {
  const h = await setup(t);
  for (const [file, mime] of [['', 'text/html'], ['local.mjs', 'text/javascript'], ['local.css', 'text/css']]) {
    const r = await h.request('/sdk/web/snake/' + file);
    assert.equal(r.status, 200); assert.ok(r.headers['content-type'].startsWith(mime)); assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['access-control-allow-origin'], '*'); assert.ok(r.headers['content-security-policy'].includes("frame-ancestors 'self'"));
    assert.ok(!r.headers['content-security-policy'].includes('unsafe-'));
  }
  const head = await h.request('/sdk/web/snake/', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal((await h.request('/sdk/web/snake/', 'POST')).headers.allow, 'GET, HEAD');
  assert.equal((await h.request('/sdk/web/snake/', 'POST')).status, 405);
  const main = await h.request('/'); assert.ok(main.headers['content-security-policy'].includes("frame-ancestors 'none'")); assert.ok(main.headers['content-security-policy'].includes("frame-src 'self'"));
  const api = await h.request('/api/sdk/catalog'); assert.equal(api.headers['access-control-allow-origin'], undefined); assert.ok(api.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  assert.equal((await h.request('/api/sdk/matches', 'POST', { Origin: 'null' })).status, 403);
  const module = await h.request('/sdk/bridge/game-client.mjs'); assert.equal(module.status, 200); assert.equal(module.headers['access-control-allow-origin'], '*');
  assert.equal((await h.request('/sdk/web/snake/', 'GET', { Host: 'invalid;host' })).status, 404);
});
test('raw traversal/encoding/backslashes/empty segments/private files/directories and oversized files fail sanitized', async (t) => {
  const h = await setup(t);
  await mkdir(path.join(h.dir, 'web/folder.css'));
  await writeFile(path.join(h.dir, 'web/large.mjs'), Buffer.alloc(1024 * 1024 + 1));
  for (const asset of ['../server/index.mjs', '%2e%2e/server/index.mjs', '%252e%252e/server/index.mjs', '%2fserver/index.mjs',
    'a\\b.mjs', 'a//b.mjs', '/local.mjs', 'server/index.mjs', 'prolog/gato.pl', 'analytics/profile.json', 'game.json', '.env', 'folder.css', 'NUL.css']) {
    const r = await h.request('/sdk/web/snake/' + asset); assert.equal(r.status, 404, asset);
    assert.ok(!/sdk-web-|server\.mjs|stack|[A-Z]:\\/.test(r.body));
  }
  assert.equal((await h.request('/sdk/web/snake/large.mjs')).status, 413);
});
test('external symlink/junction assets cannot escape web tree; static requests do not import modified server code', async (t) => {
  const h = await setup(t);
  await writeFile(path.join(h.dir, 'server/index.mjs'), "throw Error('new private server code must not execute for assets');");
  assert.equal((await h.request('/sdk/web/snake/')).status, 200);
  try { await symlink(path.join(h.dir, 'server'), path.join(h.dir, 'web/linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('No se permiten symlinks en este entorno'); return; } throw error; }
  assert.equal((await h.request('/sdk/web/snake/linked/snake-session.mjs')).status, 404);
});

test('configured HTTPS public origin controls CSP behind a proxy; spoofed forwarding and Host never downgrade it', async (t) => {
  const h = await setup(t, true, 'https://console.example:8443');
  const r = await h.request('/sdk/web/snake/', 'GET', { Host: 'backend.internal',
    Forwarded: 'host=attacker.example;proto=http', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'attacker.example' });
  assert.equal(r.status, 200);
  const csp = r.headers['content-security-policy'];
  assert.ok(csp.includes('https://console.example:8443/sdk/web/snake/'));
  assert.ok(csp.includes('https://console.example:8443/sdk/bridge/'));
  assert.ok(!csp.includes('http://') && !csp.includes('attacker') && !csp.includes('backend.internal'));
});

test('loopback HTTP remains compatible and ignores Forwarded / X-Forwarded-Proto without public-origin configuration', async (t) => {
  const h = await setup(t);
  const r = await h.request('/sdk/web/snake/', 'GET', { Forwarded: 'proto=https;host=attacker.example', 'X-Forwarded-Proto': 'https' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /http:\/\/127\.0\.0\.1:\d+\/sdk\/bridge\//);
  assert.ok(!r.headers['content-security-policy'].includes('https://') && !r.headers['content-security-policy'].includes('attacker'));
});

test('direct TLS socket derives HTTPS without proxy headers and invalid public-origin configuration fails at construction', async (t) => {
  const h = await setup(t), headers = {};
  let status;
  const handler = createWebAssets(h.app.sdk, { bridgeDirectory: path.resolve('public/sdk/bridge') });
  await handler({ url: '/sdk/web/snake/', method: 'HEAD', headers: { host: 'tls.example' }, socket: { encrypted: true } }, {
    setHeader(key, value) { headers[key] = value; }, writeHead(code) { status = code; }, end() {},
  });
  assert.equal(status, 200); assert.ok(headers['Content-Security-Policy'].includes('https://tls.example/sdk/bridge/'));
  for (const value of ['', 'https://console.example/', 'https://console.example/path', 'https://user:secret@console.example',
    'https://console.example?q=1', 'https://console.example#fragment', 'https://console.example:443', ' https://console.example',
    'https://console.example;script-src', 'ftp://console.example', '//console.example', 42, {}]) {
    assert.throws(() => createWebAssets(undefined, { bridgeDirectory: '.', publicOrigin: value }), { code: 'INVALID_CONFIGURATION' });
  }
  for (const value of ['http://127.0.0.1:3000', 'http://localhost', 'https://console.example', 'https://[::1]:8443']) {
    assert.equal(typeof createWebAssets(undefined, { bridgeDirectory: '.', publicOrigin: value }), 'function');
  }
});
