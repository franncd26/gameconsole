import { importError } from './analytics.mjs';
const send = (res, status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', abort); req.off('aborted', abort); };
    const abort = () => { cleanup(); reject(importError('IMPORT_INPUT', 'Carga interrumpida.')); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { cleanup(); req.resume(); reject(importError('ARCHIVE_TOO_LARGE', 'Solicitud demasiado grande.', 413)); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', data).on('end', end).on('error', abort).on('aborted', abort);
  });
}
export function createImporterHTTP(importer) {
  let inFlight = 0;
  return async (req, res, url) => {
    let admitted = false;
    try {
      if (url.search) throw importError('IMPORT_ROUTE', 'Ruta no disponible.', 404);
      if (url.pathname === '/api/sdk/plugins/import' && req.method === 'GET') return send(res, 200, { enabled: Boolean(importer), issues: importer?.issues || [] });
      if (!importer) throw importError('IMPORT_DISABLED', 'Importador experimental deshabilitado.', 404);
      if (!['/api/sdk/plugins/import', '/api/sdk/plugins/import/preview'].includes(url.pathname) || url.search) throw importError('IMPORT_ROUTE', 'Ruta no disponible.', 404);
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw importError('IMPORT_METHOD', 'Método no permitido.', 405); }
      let origin, host;
      try { origin = new URL(req.headers.origin); host = new URL('http://' + req.headers.host); } catch {}
      if (!origin || !host || !['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
        || !['http:', 'https:'].includes(origin.protocol) || origin.host !== host.host || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw importError('IMPORT_ORIGIN', 'Solo se admite el origen local de la consola.', 403);
      if (inFlight >= 4) throw importError('IMPORT_BUSY', 'Hay demasiadas solicitudes de importación pendientes.', 429);
      inFlight++; admitted = true;
      if (url.pathname.endsWith('/preview')) {
        if (req.headers['content-type'] !== 'application/zip') throw importError('INVALID_ARCHIVE', 'Se requiere application/zip.');
        return send(res, 200, await importer.preview(await body(req, 10 * 1024 * 1024)));
      }
      if (!/^application\/json(?:;|$)/.test(req.headers['content-type'] || '')) throw importError('IMPORT_INPUT', 'Confirmación JSON inválida.');
      let input; try { input = JSON.parse(await body(req, 2048)); } catch { throw importError('IMPORT_INPUT', 'Confirmación JSON inválida.'); }
      if (!input || Object.keys(input).length !== 1 || typeof input.token !== 'string' || !/^[a-f0-9-]{36}$/.test(input.token)) throw importError('IMPORT_INPUT', 'Se requiere el token de la vista previa.');
      return send(res, 201, await importer.install(input.token));
    } catch (error) {
      const codes = ['INVALID_ARCHIVE','ARCHIVE_TOO_LARGE','INVALID_PROFILE','DUPLICATE_ID','PREVIEW_EXPIRED','IMPORT_BUSY','ANALYTICS_ACTIVATION_FAILED','ANALYTICS_RECOVERY_PENDING','IMPORT_DISABLED','IMPORT_ORIGIN','IMPORT_METHOD','IMPORT_ROUTE','IMPORT_INPUT'];
      const safe = codes.includes(error.code);
      send(res, safe ? error.status || 400 : 400, { error: { code: safe ? error.code : 'INVALID_PACKAGE',
        message: safe ? error.message : 'El paquete no cumple el contrato SDK o no pudo prepararse. Revisa manifiesto, archivos e interfaz de sesión.' } });
    } finally { if (admitted) inFlight--; }
  };
}
