import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CATALOG, TicTacToe, Snake, Racing, GameError } from "./games.mjs";
import { EventOutbox } from "./outbox.mjs";
import { decide } from "./prolog.mjs";
import { connectSDK, prepareSDKFromEnvironment } from "./sdk/bootstrap.mjs";
import { createSDKHTTP } from "./sdk/http-api.mjs";
import { createWebAssets } from "./sdk/web-assets.mjs";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};
export function createApp({
  statsURL = process.env.GAMESTATS_URL || "http://127.0.0.1:8080",
  ai = decide,
  sdk,
  statsFetcher = fetch,
  sdkHTTP = {},
  publicOrigin = process.env.GAMECONSOLE_PUBLIC_ORIGIN,
} = {}) {
  const matches = new Map(),
    outbox = new EventOutbox(statsURL, { fetcher: statsFetcher });
  const sdkRuntime = connectSDK(sdk, outbox);
  const handleWeb = createWebAssets(sdkRuntime, { bridgeDirectory: path.join(publicDir, 'sdk/bridge'), publicOrigin });
  const handleSDK = createSDKHTTP(sdkRuntime, {
    ...sdkHTTP, outbox, statsURL, fetcher: statsFetcher,
  });
  const json = (res, code, body) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  const body = async (req) => {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 16384)
        throw new GameError("Solicitud demasiado grande.", 413);
    }
    try {
      return JSON.parse(data || "{}");
    } catch {
      throw new GameError("JSON inválido.");
    }
  };
  const upstream = async (route) => {
    try {
      const r = await statsFetcher(statsURL + route, {
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok)
        throw new GameError(
          `GameStats no está disponible (${r.status}).`,
          r.status === 404 ? 404 : 502,
        );
      return await r.json();
    } catch (e) {
      if (e instanceof GameError) throw e;
      throw new GameError(
        "No hay conexión con GameStats. Los eventos permanecen pendientes.",
        503,
      );
    }
  };
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      // Inspect raw paths before URL normalization could erase traversal segments.
      if (req.url === '/sdk/web' || req.url.startsWith('/sdk/web/') || req.url.startsWith('/sdk/bridge/'))
        return await handleWeb(req, res);
      const url = new URL(req.url, "http://localhost"),
        p = url.pathname;
      if (p === "/api/sdk" || p.startsWith("/api/sdk/"))
        return await handleSDK(req, res, url);
      if (
        p.startsWith("/api/") &&
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        throw new GameError("Origen no permitido.", 403);
      if (req.method === "GET" && p === "/api/health")
        return json(res, 200, { status: "ok" });
      if (req.method === "GET" && p === "/api/catalog")
        return json(res, 200, CATALOG);
      if (p === "/api/matches" && req.method === "GET")
        return json(
          res,
          200,
          [...matches.values()]
            .reverse()
            .map((m) => ({ ...m.snapshot(), delivery: outbox.status(m.id) })),
        );
      if (p === "/api/matches" && req.method === "POST") {
        if (matches.size >= 500)
          throw new GameError(
            "Se alcanzó el límite de 500 partidas de esta sesión. Reinicia el servicio para una nueva sesión.",
            429,
          );
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new GameError("La configuración debe ser un objeto JSON.");
        const { gameId, options = {} } = input;
        if (!options || typeof options !== "object" || Array.isArray(options))
          throw new GameError("Opciones de partida inválidas.");
        const emit = (e) => outbox.enqueue(e);
        let m;
        if (gameId === "tic-tac-toe") m = new TicTacToe(emit, ai, options);
        else if (gameId === "snake") m = new Snake(emit, Math.random, options);
        else if (gameId === "racing") m = new Racing(emit);
        else throw new GameError("Juego desconocido.");
        matches.set(m.id, m);
        return json(res, 201, m.snapshot());
      }
      if (p === "/api/dashboard" && req.method === "GET")
        return json(res, 200, await upstream("/dashboard"));
      const route = p.match(
        /^\/api\/matches\/([a-zA-Z0-9-]+)(?:\/(action|finish|results))?$/,
      );
      if (route) {
        const m = matches.get(route[1]);
        if (!m) throw new GameError("Partida inexistente.", 404);
        if (!route[2] && req.method === "GET")
          return json(res, 200, {
            ...m.snapshot(),
            delivery: outbox.status(m.id),
          });
        if (route[2] === "results" && req.method === "GET")
          return json(res, 200, await upstream(`/results/${m.gameId}/${m.id}`));
        if (route[2] === "action" && req.method === "POST") {
          const input = await body(req);
          await m.exclusive(() => m.action(input));
          return json(res, 200, {
            ...m.snapshot(),
            delivery: outbox.status(m.id),
          });
        }
        if (route[2] === "finish" && req.method === "POST") {
          await m.exclusive(() => m.finish("abandoned"));
          return json(res, 200, m.snapshot());
        }
      }
      if (p.startsWith("/api/"))
        throw new GameError("Ruta o método no disponible.", 404);
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new GameError("Método no permitido.", 405);
      const relative =
        p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\//, "");
      const target = path.resolve(publicDir, relative);
      if (!target.startsWith(publicDir))
        throw new GameError("Archivo no disponible.", 404);
      const content = await readFile(target);
      if (path.extname(target) === '.html')
        res.setHeader('Content-Security-Policy', res.getHeader('Content-Security-Policy') + "; frame-src 'self'");
      res.writeHead(200, {
        "Content-Type":
          types[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (e) {
      const status = e.status || (e.code === "ENOENT" ? 404 : 500);
      if (status === 500) console.error("Request failed:", e.message);
      json(res, status, {
        error:
          status === 500
            ? "No se pudo completar la acción. Revisa el servicio Prolog y vuelve a intentar."
            : e.message,
      });
    }
  });
  return { server, matches, outbox, sdk: sdkRuntime };
}

/** Host-only shutdown, testable without signals. Failure to close must never skip flush. */
export async function shutdownApp(app) {
  const report = { closeFailures: [], delivery: { status: 'pending' } };
  try {
    const historical = [...app.matches.values()];
    const operations = historical.map((m) => () => m.exclusive(() => m.finish("shutdown")));
    operations.push(() => app.sdk?.shutdown());
    const settled = await Promise.allSettled(operations.map((close) => Promise.resolve().then(close)));
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') continue;
      if (index < historical.length) {
        report.closeFailures.push({ source: 'historical', code: 'HISTORICAL_CLOSE_FAILED' });
      } else {
        // shutdown() aggregates only sanitized codes after all SDK closes settle.
        const allowed = ['CLEANUP_FAILED', 'EVENT_ACCEPTANCE_FAILED', 'EVENT_SINK_UNAVAILABLE',
          'INVALID_SNAPSHOT', 'VERSION_LIMIT', 'UNKNOWN_MATCH', 'INVALID_LIFECYCLE',
          'SDK_CLOSE_FAILED', 'SDK_ENUMERATION_FAILED'];
        const failures = result.reason?.code === 'SDK_SHUTDOWN_FAILED' && Array.isArray(result.reason.failures)
          ? result.reason.failures : [{ code: 'SDK_CLOSE_FAILED' }];
        report.closeFailures.push(...failures.map((failure) => ({ source: 'sdk',
          code: allowed.includes(failure.code) ? failure.code : 'SDK_CLOSE_FAILED' })));
      }
    }
  } catch {
    report.closeFailures.push({ source: 'host', code: 'SHUTDOWN_CLOSE_FAILED' });
  } finally {
    try {
      await app.outbox.flush(5000);
      report.delivery = { status: 'flushed' };
    } catch {
      report.delivery = { status: 'failed', code: 'OUTBOX_FLUSH_FAILED' };
    } finally {
      app.outbox.stop();
    }
  }
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let app;
  try { app = createApp({ sdk: await prepareSDKFromEnvironment() }); }
  catch (error) {
    console.error(`SDK bootstrap: ${error.code ?? "SDK_FAILURE"}; no se inicia el servidor.`);
    process.exitCode = 1;
  }
  if (app) {
    const port = Number(process.env.PORT || 3000);
    app.server.listen(port, process.env.HOST || "127.0.0.1", () =>
      console.log(`GameConsole: http://127.0.0.1:${port}`),
    );
    let stopping;
    const shutdown = () => {
      stopping ??= (async () => {
        const report = await shutdownApp(app);
        for (const failure of report.closeFailures)
          console.error(`Apagado: ${failure.source}/${failure.code}.`);
        if (report.delivery.status === 'failed')
          console.error("OUTBOX_FLUSH_FAILED: quedaron eventos cuya entrega no se confirmó.");
        const exitCode = report.closeFailures.length || report.delivery.status === 'failed' ? 1 : 0;
        app.server.close(() => process.exit(exitCode));
        setTimeout(() => process.exit(1), 2000).unref();
      })();
      return stopping;
    };
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
  }
}
