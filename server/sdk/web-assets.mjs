import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { SDKError } from './values.mjs';

const MAX = 1024 * 1024;
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const bridgeFiles = new Set(['protocol.mjs', 'host-bridge.mjs', 'game-client.mjs', 'plugin-status.mjs', 'harness.mjs']);
const inside = (root, file) => { const r = path.relative(root, file); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const segment = (s) => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/.test(s) && !s.endsWith('.')
  && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)
  && !['server', 'prolog', 'analytics', 'node_modules'].includes(s.toLowerCase());
const authority = /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/;
function validatePublicOrigin(value) {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string') throw Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || !authority.test(url.host)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
    return url.origin;
  } catch { throw new SDKError('INVALID_CONFIGURATION', 'GAMECONSOLE_PUBLIC_ORIGIN debe ser un origen HTTP(S) canónico, sin ruta, credenciales ni query.'); }
}
function origin(req, configured) {
  if (configured) return configured;
  const value = req.headers.host;
  if (typeof value !== 'string' || !authority.test(value)) throw Error();
  // Only the actual connection controls the scheme. Forwarded headers are untrusted.
  const url = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${value}`);
  if (url.host !== value || url.pathname !== '/' || url.username || url.password) throw Error();
  return url.origin;
}
export function pluginCSP(base, gameId) {
  return `default-src 'none'; script-src ${base}/sdk/web/${gameId}/ ${base}/sdk/bridge/; style-src ${base}/sdk/web/${gameId}/; img-src ${base}/sdk/web/${gameId}/ data:; font-src ${base}/sdk/web/${gameId}/; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
}
/** Metadata-only static reads. No loader, import(), or plugin execution occurs here. */
export function createWebAssets(runtime, { bridgeDirectory, publicOrigin }) {
  const configuredOrigin = validatePublicOrigin(publicOrigin);
  return async (req, res) => {
    let status = 404, handle;
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { status = 405; res.setHeader('Allow', 'GET, HEAD'); throw Error(); }
      const raw = req.url;
      if (/[\\%?#\u0000-\u0020]/u.test(raw)) throw Error();
      let root, target, gameId;
      if (raw.startsWith('/sdk/bridge/')) {
        const name = raw.slice('/sdk/bridge/'.length);
        if (!bridgeFiles.has(name)) throw Error();
        root = await realpath(bridgeDirectory); target = path.join(root, name);
      } else {
        const match = /^\/sdk\/web\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.*)$/.exec(raw);
        if (!match || match[1].length > 64 || !runtime) throw Error();
        gameId = match[1];
        const pkg = runtime.webPackage(gameId);
        if (!pkg) throw Error();
        root = await realpath(path.dirname(path.resolve(pkg.directory, pkg.manifest.entrypoints.web)));
        // Serving a whole package root could expose private ESM siblings. Web needs a separate tree.
        if (!inside(pkg.directory, root) || inside(root, pkg.paths.server)
          || (pkg.paths.profile && inside(root, pkg.paths.profile)) || !inside(root, pkg.paths.web)) throw Error();
        const assets = match[2] ? match[2].split('/') : [path.basename(pkg.paths.web)];
        if (!assets.every(segment)) throw Error();
        target = match[2] ? path.join(root, ...assets) : pkg.paths.web;
      }
      const type = types[path.extname(target)];
      if (!type) throw Error();
      target = await realpath(target);
      if (!inside(root, target) || !(await stat(target)).isFile()) throw Error();
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile()) throw Error();
      if (info.size > MAX) { status = 413; throw Error(); }
      let content;
      if (req.method === 'GET') {
        const buffer = Buffer.alloc(MAX + 1); let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > MAX) { status = 413; throw Error(); }
        content = buffer.subarray(0, total);
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*'); // Public static resources only; never credentials or API.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (gameId) res.setHeader('Content-Security-Policy', pluginCSP(origin(req, configuredOrigin), gameId));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': content?.length ?? info.size, 'Cache-Control': 'no-store' });
      res.end(content);
    } catch {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: { code: status === 405 ? 'METHOD_NOT_ALLOWED' : status === 413 ? 'ASSET_TOO_LARGE' : 'WEB_NOT_FOUND', message: 'Recurso web no disponible.' } }));
    } finally { await handle?.close(); }
  };
}
