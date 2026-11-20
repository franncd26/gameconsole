import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

const ids = ['tic-tac-toe', 'snake', 'racing'];
const pinnedRef = '4adee854ea3b35148b1eadd0549d4d8e647b345c';
class IntegrationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireCheck = (condition, code) => { if (!condition) throw new IntegrationError(code); };
const equal = (a, b, code) => requireCheck(isDeepStrictEqual(a, b), code);
function origin(value) {
  try {
    const url = new URL(value);
    requireCheck(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/', 'INVALID_ORIGIN');
    return url.origin;
  } catch { throw new IntegrationError('INVALID_ORIGIN'); }
}

/** Calls an ALREADY DEPLOYED console and Go. Never starts servers, Docker, Prolog or mock services. */
export async function runSDKIntegration({
  consoleURL = process.env.CONSOLE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
  goURL = process.env.GAMESTATS_URL || `http://127.0.0.1:${process.env.GAMESTATS_PORT || 8080}`,
  timeoutMs = Number(process.env.SDK_INTEGRATION_TIMEOUT_MS || 120000), pollMs = 500,
  fetcher = globalThis.fetch, evidenceFile = new URL('../evidence/sdk-integration.json', import.meta.url),
} = {}) {
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
    transport: fetcher === globalThis.fetch ? 'configured-http-services' : 'injected-test-transport',
    expectedGameStatsRef: pinnedRef, refVerification: 'Build source is checked by prepare/CI; HTTP does not expose its Git SHA.',
    stage: 'configuration', mutationsMayHaveOccurred: false, checks: [], creation: [], matches: [], cleanup: [] };
  let signal, base, go, deadlineTimer;
  const known = new Map();
  const route = s => '/api/sdk/matches/' + encodeURIComponent(s.matchId);
  const checked = name => report.checks.push(name);
  async function request(target, resource, { body, expected = [200], text = false } = {}) {
    let response, value;
    try {
      response = await fetcher(target + resource, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!expected.includes(response.status)) throw new IntegrationError('HTTP_' + response.status);
      value = text ? await response.text() : await response.json();
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(signal.aborted ? 'GLOBAL_TIMEOUT' : body === undefined ? 'HTTP_READ_FAILED' : 'HTTP_OUTCOME_UNKNOWN');
    }
    return { status: response.status, value };
  }
  const local = async (resource, options) => (await request(base, resource, options)).value;
  const remote = async resource => (await request(go, resource)).value;
  function identity(value, reference, state) {
    equal([value.gameId, value.matchId, value.state], [reference.gameId, reference.matchId, state], 'IDENTITY_OR_STATE_MISMATCH');
  }
  async function waitFor(read, ready) {
    const limit = Math.ceil(timeoutMs / pollMs);
    for (let attempt = 0; attempt < limit; attempt++) {
      const value = await read();
      if (ready(value)) return value;
      await delay(pollMs, undefined, { signal });
    }
    throw new IntegrationError('POLL_LIMIT');
  }
  async function delivered(reference) {
    const snapshot = await waitFor(() => local(route(reference)), s => s.delivery?.pending === 0);
    const state = snapshot.state === 'finished' ? 'closed' : 'open';
    const ingestion = await remote(`/matches/${reference.gameId}/${reference.matchId}`);
    identity(ingestion, reference, state);
    requireCheck(Array.isArray(ingestion.eventIds) && ingestion.eventIds.length === ingestion.eventCount
      && new Set(ingestion.eventIds).size === ingestion.eventCount, 'REMOTE_EVENT_IDS_INVALID');
    equal(ingestion.eventCount, snapshot.delivery.delivered, 'OUTBOX_REMOTE_COUNT_MISMATCH');
    return ingestion;
  }
  function metric(result, id, scope, subject, template, instance, analyzer = false) {
    const rows = result.metrics.filter(m => m.id === id && m.scope === scope && m.subjectId === subject);
    requireCheck(rows.length === 1, 'PROFILE_METRIC_MISSING_OR_DUPLICATE');
    const row = rows[0];
    equal(row.source?.[analyzer ? 'analyzerId' : 'templateId'], template, 'METRIC_SOURCE_MISMATCH');
    equal(row.source.instanceId, instance, 'METRIC_INSTANCE_MISMATCH');
    return row;
  }
  async function analyzed(reference, ingestion, state) {
    const response = await waitFor(() => request(base, route(reference) + '/results', { expected: [200, 202] }), r => r.status === 200);
    const result = response.value; identity(result, reference, state);
    requireCheck(Array.isArray(result.metrics) && Array.isArray(result.patterns), 'ANALYTICS_ARRAYS_MISSING');
    for (const row of [...result.metrics, ...result.patterns]) {
      requireCheck(['provisional', 'final', 'unavailable'].includes(row.status), 'ANALYTICS_STATUS_INVALID');
      equal(row.source?.profileVersion, '1.0.0', 'PROFILE_VERSION_MISMATCH');
      equal(row.basis?.eventCount, ingestion.eventCount, 'ANALYTICS_BASIS_MISMATCH');
      equal(row.basis?.lastEventId, ingestion.eventIds.at(-1), 'ANALYTICS_PREFIX_MISMATCH');
      if (row.status === 'unavailable') requireCheck(typeof row.reason === 'string' && (row.value === null || row.count === null), 'UNAVAILABLE_WITHOUT_REASON');
    }
    const availability = state === 'open' ? 'provisional' : 'final';
    if (reference.gameId === 'tic-tac-toe') {
      const moves = metric(result, 'moves.match', 'match', reference.matchId, 'event-metrics/v1', 'moves');
      equal([moves.status, moves.value], [availability, 2], 'GATO_MOVES_MISMATCH');
      const board = metric(result, 'board.result', 'match', reference.matchId, 'tic-tac-toe-line/v1', 'board', true);
      if (state === 'open') { equal(board.status, 'provisional', 'BOARD_NOT_PROVISIONAL'); equal(board.value, { outcome: 'in_progress', winnerId: null }, 'BOARD_RESULT_MISMATCH'); }
      else equal([board.status, board.reason, board.value], ['unavailable', 'insufficient_evidence', null], 'ABANDONED_BOARD_MISMATCH');
    } else if (reference.gameId === 'snake') {
      const apples = metric(result, 'apples.match', 'match', reference.matchId, 'event-metrics/v1', 'apples');
      equal(apples.status, availability, 'SNAKE_NOT_LIVE_OR_FINAL'); requireCheck(Number.isSafeInteger(apples.value) && apples.value >= 0, 'SNAKE_COUNT_INVALID');
      metric(result, 'points.player', 'player', 'human', 'event-metrics/v1', 'apples');
      requireCheck(result.patterns.some(p => p.id === 'apples.burst' && p.source.templateId === 'temporal-window/v1'), 'SNAKE_PATTERN_MISSING');
    } else {
      const laps = metric(result, 'laps.match', 'match', reference.matchId, 'event-metrics/v1', 'laps');
      equal([laps.status, laps.value], [availability, 0], 'RACING_LAPS_MISMATCH');
      const average = metric(result, 'lap_time.avg.player', 'player', 'human', 'event-metrics/v1', 'laps');
      equal([average.status, average.reason, average.value], ['unavailable', 'no_samples', null], 'EMPTY_AVERAGE_MISMATCH');
    }
    const duration = metric(result, 'duration.match', 'match', reference.matchId, 'duration/v1', 'duration');
    if (state === 'open') equal([duration.status, duration.reason, duration.value], ['unavailable', 'awaiting_finish', null], 'LIVE_DURATION_MISMATCH');
    else requireCheck(duration.status === 'final' && Number.isFinite(duration.value) && duration.value >= 0, 'FINAL_DURATION_INVALID');
    return result;
  }
  function dashboard(value) {
    equal(value.source, 'GameStats / Scala', 'REAL_ANALYTICS_SOURCE_REQUIRED');
    equal(value.consistency, 'per_match_snapshot', 'SUMMARY_CONSISTENCY_MISMATCH');
    requireCheck(value.totals && ['started','active','finished','events'].every(k => Number.isSafeInteger(value.totals[k]) && value.totals[k] >= 0)
      && Array.isArray(value.games) && Array.isArray(value.matches), 'SUMMARY_CONTRACT_INVALID');
    return value;
  }
  function summaryChecks(summary, before, state, eventCount) {
    equal(summary.totals.started - before.totals.started, 3, 'STARTED_DELTA_MISMATCH');
    equal(summary.totals.finished - before.totals.finished, state === 'closed' ? 3 : 0, 'FINISHED_DELTA_MISMATCH');
    equal(summary.totals.active - before.totals.active, state === 'open' ? 3 : 0, 'ACTIVE_DELTA_MISMATCH');
    equal(summary.totals.events - before.totals.events, eventCount, 'EVENT_DELTA_MISMATCH');
    for (const match of report.matches) {
      requireCheck(summary.matches.some(m => m.matchId === match.matchId && m.gameId === match.gameId && m.state === state), 'SUMMARY_MATCH_MISSING');
      requireCheck(summary.games.some(g => g.gameId === match.gameId), 'SUMMARY_GAME_MISSING');
    }
  }
  try {
    requireCheck(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180000
      && Number.isSafeInteger(pollMs) && pollMs >= 100 && pollMs <= 2000, 'INVALID_TIME_LIMITS');
    const deadline = new AbortController(); signal = deadline.signal;
    // Unlike AbortSignal.timeout(), this referenced timer owns the global deadline
    // even when a transport promise has no socket or other active event-loop handle.
    deadlineTimer = setTimeout(() => deadline.abort(), timeoutMs);
    base = origin(consoleURL); go = origin(goURL);
    report.stage = 'preflight';
    requireCheck((await local('/api/health')).status === 'ok' && (await remote('/health')).status === 'ok', 'HEALTH_FAILED');
    requireCheck((await local('/', { text: true })).includes('/sdk/console.mjs'), 'SDK_ROOT_NOT_ENABLED');
    report.before = dashboard(await local('/api/dashboard'));
    dashboard(await remote('/dashboard'));
    const catalog = await local('/api/sdk/catalog');
    equal(catalog.map(p => p.id).sort(), [...ids].sort(), 'CATALOG_NOT_EXACTLY_THREE');
    const existing = await local('/api/sdk/matches');
    requireCheck(existing.every(s => s.state === 'finished' && s.delivery?.pending === 0), 'REQUIRES_QUIET_DEPLOYMENT');
    checked('SDK root, exact catalog, healthy Go and Scala dashboard');
    report.stage = 'create'; report.mutationsMayHaveOccurred = true;
    const creation = await Promise.allSettled(ids.map(async gameId => {
      const attempt = { gameId, status: 'outcome-unknown' }; report.creation.push(attempt);
      const snapshot = await local('/api/sdk/matches', { body: { gameId, options: {} }, expected: [201] });
      attempt.status = 'locally-created'; attempt.matchId = snapshot.matchId;
      known.set(snapshot.matchId, snapshot);
      report.matches.push({ gameId, matchId: snapshot.matchId, initial: { state: snapshot.state, version: snapshot.version } });
      equal(snapshot.gameId, gameId, 'CREATED_GAME_MISMATCH'); equal(snapshot.state, 'running', 'CREATED_NOT_RUNNING');
      requireCheck(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshot.matchId), 'MATCH_NOT_UUID');
      return snapshot;
    }));
    const failure = creation.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    equal(known.size, 3, 'MATCH_IDENTITIES_NOT_UNIQUE');
    const created = new Map([...known.values()].map(s => [s.gameId, s]));
    const listed = await local('/api/sdk/matches');
    for (const s of known.values()) requireCheck(listed.some(m => m.matchId === s.matchId && m.gameId === s.gameId && m.state === 'running'), 'CONCURRENT_MATCH_MISSING');
    checked('Three distinct SDK sessions running concurrently');
    report.stage = 'actions-and-prolog';
    const gato = created.get('tic-tac-toe');
    const input = { requestId: 'sdk-compose-human-1', type: 'PLACE_MARK', payload: { index: 0 }, expectedVersion: gato.version };
    const played = await local(route(gato) + '/actions', { body: input });
    report.matches.find(m => m.gameId === gato.gameId).action = { outcome: played.outcome, committed: played.committed, confirmations: played.confirmations, snapshot: played.snapshot };
    requireCheck(played.outcome === 'completed' && played.committed && played.confirmations === 2, 'REAL_PROLOG_ACTION_NOT_COMPLETED');
    const board = played.snapshot.data;
    requireCheck(board.board[0] === 'X' && board.board.filter(v => v === 'O').length === 1 && board.turn === 2
      && board.awaitingAI === false && board.lastDecision?.algorithm === 'minimax'
      && board.board[board.lastDecision.index] === 'O', 'REAL_PROLOG_DECISION_NOT_CONFIRMED');
    requireCheck(played.snapshot.version > gato.version && played.snapshot.state === 'running', 'GATO_VERSION_OR_STATE');
    const isolated = async s => { const current = await local(route(s)); equal([current.version, current.data], [s.version, s.data], 'CROSS_MATCH_MUTATION'); };
    await isolated(created.get('snake')); await isolated(created.get('racing'));
    const moved = await local(route(created.get('snake')) + '/actions', { body: { requestId: 'sdk-compose-tick-1', type: 'TICK', payload: { direction: 'up' }, expectedVersion: created.get('snake').version } });
    report.matches.find(m => m.gameId === 'snake').action = { outcome: moved.outcome, committed: moved.committed, confirmations: moved.confirmations, snapshot: moved.snapshot };
    requireCheck(moved.outcome === 'completed' && moved.committed && moved.snapshot.version > created.get('snake').version && moved.snapshot.state === 'running', 'SNAKE_ACTION_FAILED');
    await isolated(played.snapshot); await isolated(created.get('racing'));
    const stepped = await local(route(created.get('racing')) + '/actions', { body: { requestId: 'sdk-compose-step-1', type: 'STEP', payload: { lane: 2, accelerate: true, brake: false }, expectedVersion: created.get('racing').version } });
    report.matches.find(m => m.gameId === 'racing').action = { outcome: stepped.outcome, committed: stepped.committed, confirmations: stepped.confirmations, snapshot: stepped.snapshot };
    requireCheck(stepped.outcome === 'completed' && stepped.committed && stepped.snapshot.version > created.get('racing').version && stepped.snapshot.state === 'running', 'RACING_ACTION_FAILED');
    await isolated(played.snapshot); await isolated(moved.snapshot);
    checked('Real deployed Prolog decision, TICK, STEP, public versions and isolated domain state');
    report.stage = 'live-delivery-and-analysis'; let liveEvents = 0;
    for (const match of report.matches) {
      match.local = await local(route(match));
      match.ingestionOpen = await delivered(match); liveEvents += match.ingestionOpen.eventCount;
      match.provisional = await analyzed(match, match.ingestionOpen, 'open');
    }
    report.stage = 'idempotency';
    const beforeReplay = await delivered(gato);
    equal(await local(route(gato) + '/actions', { body: input }), played, 'REPLAY_RESULT_CHANGED');
    equal((await delivered(gato)).eventIds, beforeReplay.eventIds, 'REPLAY_DUPLICATED_EVENTS');
    checked('Same requestId returns original result with unchanged remote event IDs');
    report.live = dashboard(await local('/api/dashboard')); summaryChecks(report.live, report.before, 'open', liveEvents);
    checked('Outbox delivered open prefixes; Scala profile metrics and provisional availability verified');
    report.stage = 'finish';
    const closing = await Promise.allSettled(report.matches.map(async match => {
      const snapshot = await local(route(match) + '/finish', { body: { reason: 'sdk_integration_completed' } });
      equal(snapshot.state, 'finished', 'CLOSE_NOT_CONFIRMED'); match.finished = { state: snapshot.state, version: snapshot.version };
    }));
    const closeFailure = closing.find(r => r.status === 'rejected'); if (closeFailure) throw closeFailure.reason;
    report.stage = 'final-delivery-and-analysis'; let finalEvents = 0;
    for (const match of report.matches) {
      match.ingestionClosed = await delivered(match); finalEvents += match.ingestionClosed.eventCount;
      equal(match.ingestionClosed.eventCount, match.ingestionOpen.eventCount + 1, 'FINISH_EVENT_COUNT_MISMATCH');
      equal(match.ingestionClosed.eventIds.slice(0, -1), match.ingestionOpen.eventIds, 'EVENT_ORDER_CHANGED');
      match.final = await analyzed(match, match.ingestionClosed, 'closed');
    }
    report.after = dashboard(await local('/api/dashboard')); summaryChecks(report.after, report.before, 'closed', finalEvents);
    checked('Three unique ordered closes delivered; final/unavailable metrics and dashboard +3 finished verified');
    report.status = 'passed'; report.stage = 'complete';
  } catch (error) {
    report.status = 'failed'; report.failure = { stage: report.stage,
      code: error instanceof IntegrationError ? error.code : signal?.aborted ? 'GLOBAL_TIMEOUT' : 'CONTRACT_CHECK_FAILED',
      message: 'Comprobación no confirmada. Puede haber partidas/eventos creados; no se afirma rollback.' };
    // Best effort only for known IDs within the SAME global deadline. Never touch pre-existing matches.
    for (const snapshot of known.values()) {
      let status = 'unconfirmed';
      if (!signal.aborted) try {
        const current = await local(route(snapshot));
        const closed = current.state === 'finished' ? current : await local(route(snapshot) + '/finish', { body: { reason: 'sdk_integration_cleanup' } });
        status = closed.state === 'finished' ? 'locally-finished-delivery-not-verified' : 'closing';
      } catch { /* Keep the original stage/code, not private network/plugin errors. */ }
      report.cleanup.push({ matchId: snapshot.matchId, status });
    }
  } finally { clearTimeout(deadlineTimer); }
  report.finishedAt = new Date().toISOString();
  if (evidenceFile !== null) {
    const file = evidenceFile instanceof URL ? fileURLToPath(evidenceFile) : evidenceFile;
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runSDKIntegration();
    console.log(JSON.stringify({ status: report.status, stage: report.stage, failure: report.failure,
      transport: report.transport, matches: report.matches.map(m => ({ gameId: m.gameId, matchId: m.matchId })) }, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch { console.error('No se pudo guardar la evidencia SDK; validación no certificada.'); process.exitCode = 1; }
}
