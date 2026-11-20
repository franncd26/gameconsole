// Development/test transport ONLY. This is not Scala and does not implement game profiles.
export function analysisDouble(ids) {
  const events = [];
  const fetcher = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === '/events') { events.push(JSON.parse(init.body)); return Response.json({ status: 'accepted' }, { status: 201 }); }
    const counts = (rows) => ({ started: rows.filter(e => e.type === 'MATCH_STARTED').length,
      active: rows.filter(e => e.type === 'MATCH_STARTED').length - rows.filter(e => e.type === 'MATCH_FINISHED').length,
      finished: rows.filter(e => e.type === 'MATCH_FINISHED').length, events: rows.length });
    if (route === '/dashboard') return Response.json({ source: 'SIMULADO · sin Go/Scala', scope: 'demo_process', consistency: 'test_fixture',
      totals: counts(events), games: ids.map(gameId => ({ gameId, ...counts(events.filter(e => e.gameId === gameId)), metrics: [] })), matches: [] });
    const match = /^\/results\/([^/]+)\/([^/]+)$/.exec(route);
    if (!match) return Response.json({}, { status: 404 });
    const [, gameId, matchId] = match, rows = events.filter(e => e.matchId === matchId), closed = rows.some(e => e.type === 'MATCH_FINISHED');
    return Response.json({ gameId, matchId, state: closed ? 'closed' : 'open', metrics: [{
      id: 'demo.received', label: 'SIMULADO: eventos recibidos', scope: 'match', subjectId: matchId,
      value: rows.length, unit: 'events', status: closed ? 'final' : 'provisional',
      basis: { eventCount: rows.length }, source: { templateId: 'test-double', instanceId: 'demo', profileVersion: 'test' },
    }], patterns: [] });
  };
  return { fetcher, events };
}
