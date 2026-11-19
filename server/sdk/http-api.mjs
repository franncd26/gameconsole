import { isObject, requireSDK } from './values.mjs';

class HTTPError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const errors = {
  INVALID_INPUT: [400, 'Cuerpo o contrato de entrada inválido.'],
  INVALID_ACTION: [400, 'Sobre de acción inválido.'],
  INVALID_OPTIONS: [400, 'Opciones inválidas.'],
  INVALID_PLAYERS: [400, 'Participantes inválidos.'],
  INVALID_CONFIGURATION: [400, 'Configuración inválida.'],
  UNKNOWN_PLUGIN: [404, 'Plugin no disponible.'],
  UNTRUSTED_PLUGIN: [404, 'Plugin no disponible.'],
  UNKNOWN_MATCH: [404, 'Partida no disponible.'],
  INVALID_LIFECYCLE: [409, 'Ciclo de vida incompatible.'],
  MULTIPLE_INSTANCES_DISABLED: [409, 'El plugin no permite otra instancia activa.'],
  REQUEST_CONFLICT: [409, 'requestId identifica otro contenido.'],
  VERSION_CONFLICT: [409, 'expectedVersion no coincide.'],
  COORDINATED_STATE_REQUIRED: [409, 'El plugin requiere estado coordinado.'],
  INSTANCE_LIMIT: [429, 'Se alcanzó el límite de partidas.'],
  ACTIVATION_FAILED: [503, 'No se aceptó el inicio; la preparación fue descartada.'],
  EVENT_ACCEPTANCE_FAILED: [503, 'No se aceptó el evento localmente.'],
  EVENT_SINK_UNAVAILABLE: [503, 'El transporte local no está disponible.'],
  DISPATCH_FAILED: [503, 'Resultado desconocido; consulta el snapshot y reutiliza requestId cuidadosamente.'],
};
function fail(code) {
  const known = Object.hasOwn(errors, code);
  const [status, message] = known ? errors[code] : [502, 'No se pudo completar la operación SDK.'];
  return new HTTPError(status, known ? code : 'SDK_FAILURE', message);
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function readJSON(req, allowEmpty = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted); };
    const abort = (error) => { cleanup(); req.resume(); reject(error); };
    const aborted = () => abort(fail('INVALID_INPUT'));
    const data = (chunk) => {
      size += chunk.length;
      if (size > 16384) return abort(new HTTPError(413, 'BODY_TOO_LARGE', 'El cuerpo supera 16384 bytes.'));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        if (!size && allowEmpty) return resolve({});
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fail('INVALID_INPUT');
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch { reject(fail('INVALID_INPUT')); }
    };
    req.on('data', data).on('end', end).on('error', aborted).on('aborted', aborted);
  });
}
function originAllowed(req) {
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.host === req.headers.host;
  } catch { return false; }
}

/** HTTP facade only; all game execution and serialization remain in the existing manager. */
export function createSDKHTTP(runtime, { outbox, statsURL, fetcher = fetch, maxPending = 64, resultsTimeoutMs = 12000 } = {}) {
  requireSDK(Number.isInteger(maxPending) && maxPending >= 1 && maxPending <= 256
    && Number.isSafeInteger(resultsTimeoutMs) && resultsTimeoutMs > 0,
  'INVALID_CONFIGURATION', 'Límites HTTP SDK inválidos.');
  let base;
  if (runtime) {
    try {
      base = new URL(statsURL);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error();
    } catch { throw fail('INVALID_CONFIGURATION'); }
  }
  let pending = 0;
  const delivery = (id) => {
    const d = outbox.status(id);
    return { pending: d.pending, delivered: d.delivered, status: d.pending ? 'pending' : 'delivered',
      error: d.error ? 'DELIVERY_FAILED' : null };
  };
  const report = (snapshot) => ({ ...snapshot, delivery: delivery(snapshot.matchId) });
  const snapshotFor = async (id) => {
    const snapshot = await runtime.manager.getSnapshot(id);
    if (!runtime.isTrusted(snapshot.gameId) || snapshot.state === 'prepared') throw fail('UNKNOWN_MATCH');
    return snapshot;
  };
  const results = async (id, res) => {
    const snapshot = await snapshotFor(id), before = delivery(id);
    const waiting = (code) => json(res, 202, { status: 'pending', code, snapshot: report(snapshot) });
    if (before.pending) return waiting('DELIVERY_PENDING');
    let response, value;
    try {
      response = await fetcher(`${base.href.replace(/\/$/, '')}/results/${encodeURIComponent(snapshot.gameId)}/${encodeURIComponent(id)}`,
        { signal: AbortSignal.timeout(resultsTimeoutMs), redirect: 'error' });
      if (response.ok) {
        const text = await response.text();
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new HTTPError(502, 'ANALYTICS_INVALID', 'Respuesta analítica inválida.');
        try { value = JSON.parse(text); }
        catch { throw new HTTPError(502, 'ANALYTICS_INVALID', 'Respuesta analítica inválida.'); }
      }
    } catch (error) {
      if (error instanceof HTTPError) throw error;
      throw new HTTPError(['TimeoutError', 'AbortError'].includes(error?.name) ? 504 : 503,
        'ANALYTICS_UNAVAILABLE', 'No se pudo consultar el servicio analítico.');
    }
    const current = await snapshotFor(id), after = delivery(id);
    if (after.pending || current.version !== snapshot.version || current.state !== snapshot.state || after.delivered !== before.delivered) {
      return json(res, 202, { status: 'pending', code: after.pending ? 'DELIVERY_PENDING' : 'RESULTS_CHANGED', snapshot: report(current) });
    }
    if (!response.ok) throw new HTTPError([404, 503, 504].includes(response.status) ? response.status : 502,
      'ANALYTICS_UNAVAILABLE', 'El servicio analítico no pudo devolver resultados.');
    if (!isObject(value) || value.gameId !== snapshot.gameId || value.matchId !== id
      || value.state !== (snapshot.state === 'finished' ? 'closed' : 'open')
      || !Array.isArray(value.metrics) || !Array.isArray(value.patterns)) {
      throw new HTTPError(502, 'ANALYTICS_INVALID', 'Respuesta analítica incompatible.');
    }
    return json(res, 200, { gameId: value.gameId, matchId: value.matchId, state: value.state,
      metrics: value.metrics, patterns: value.patterns });
  };
  return async function handleSDK(req, res, url) {
    let admitted = false, id;
    try {
      if (!originAllowed(req)) throw new HTTPError(403, 'ORIGIN_FORBIDDEN', 'Origen no permitido.');
      if (!runtime) throw new HTTPError(404, 'SDK_DISABLED', 'API SDK deshabilitada.');
      const route = /^\/api\/sdk\/(catalog|matches)(?:\/([^/]+)(?:\/(actions|finish|results))?)?$/.exec(url.pathname);
      if (!route || url.search || (route[1] === 'catalog' && route[2])) throw fail('UNKNOWN_MATCH');
      const [, resource, encodedId, operation] = route;
      const methods = resource === 'catalog' || (encodedId && !operation) || operation === 'results'
        ? ['GET'] : operation ? ['POST'] : ['GET', 'POST'];
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw new HTTPError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      }
      if (pending >= maxPending) throw new HTTPError(429, 'HTTP_ADMISSION_LIMIT', 'Hay demasiadas solicitudes SDK pendientes.');
      pending++; admitted = true;
      if (encodedId) { try { id = decodeURIComponent(encodedId); } catch { throw fail('INVALID_INPUT'); } }
      if (resource === 'catalog') return json(res, 200, runtime.catalog());
      if (!id) {
        if (req.method === 'GET') return json(res, 200, (await runtime.manager.list()).filter((s) => s.state !== 'prepared').map(report));
        const input = await readJSON(req);
        if (!isObject(input) || Object.keys(input).some((k) => !['gameId', 'options', 'players'].includes(k))
          || typeof input.gameId !== 'string' || (Object.hasOwn(input, 'options') && !isObject(input.options))
          || (Object.hasOwn(input, 'players') && !Array.isArray(input.players))) throw fail('INVALID_INPUT');
        if (!runtime.isTrusted(input.gameId)) throw fail('UNKNOWN_PLUGIN');
        const config = Object.fromEntries(['options', 'players'].filter((k) => Object.hasOwn(input, k)).map((k) => [k, input[k]]));
        const prepared = await runtime.manager.create(input.gameId, config);
        return json(res, 201, report(await runtime.manager.activate(prepared.matchId)));
      }
      if (!operation) return json(res, 200, report(await snapshotFor(id)));
      if (operation === 'results') return await results(id, res);
      if (operation === 'actions') {
        const result = await runtime.manager.dispatch(id, await readJSON(req));
        const status = result.outcome === 'rejected' && errors[result.error?.code] ? errors[result.error.code][0] : 200;
        return json(res, status, result);
      }
      const input = await readJSON(req, true);
      if (!isObject(input) || Object.keys(input).some((k) => k !== 'reason') || (Object.hasOwn(input, 'reason')
        && (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 128 || /\p{Cc}/u.test(input.reason)))) throw fail('INVALID_INPUT');
      return json(res, 200, report(await runtime.manager.finish(id, input)));
    } catch (error) {
      const safe = error instanceof HTTPError ? error : fail(error?.code);
      const body = { error: { code: safe.code === 'DISPATCH_FAILED' ? 'RESULT_UNKNOWN' : safe.code, message: safe.message } };
      if (id && ['CLEANUP_FAILED', 'INVALID_SNAPSHOT', 'EVENT_ACCEPTANCE_FAILED'].includes(error?.code)) {
        try { body.snapshot = report(await snapshotFor(id)); } catch { /* No fabricated state. */ }
      }
      req.resume();
      json(res, safe.status, body);
    } finally { if (admitted) pending--; }
  };
}
