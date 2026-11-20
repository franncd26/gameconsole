import { validateSnapshot } from './bridge/protocol.mjs';

const messages = {
  MULTIPLE_INSTANCES_DISABLED: 'Este plugin ya tiene una partida sin finalizar. Puedes abrirla o finalizarla.',
  SDK_DISABLED: 'SDK deshabilitado. Habilita el SDK y configura los plugins confiables en el servidor.',
  INSTANCE_LIMIT: 'Se alcanzó el límite de partidas del servidor.',
  INVALID_OPTIONS: 'Revisa las opciones de la partida.',
  UNKNOWN_MATCH: 'La partida ya no está disponible en este proceso.',
};
export class ConsoleError extends Error {
  constructor(status = 0, code = 'NETWORK_ERROR', snapshot) {
    const safe = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'HTTP_ERROR';
    super(messages[safe] || ({ 404: 'Partida o resultados no disponibles.', 502: 'Respuesta analítica inválida o fallida.',
      503: 'Servicio temporalmente no disponible.', 504: 'El servicio analítico tardó demasiado.' }[status]) ||
      'No se pudo completar la solicitud. Consulta el estado antes de reintentar.');
    this.status = status; this.code = safe; this.snapshot = snapshot;
  }
}
export class ConsoleAPI {
  constructor(fetcher = (...args) => globalThis.fetch(...args)) { this.fetcher = fetcher; }
  async request(route, { body, signal, pending = false } = {}) {
    let response, value;
    try {
      response = await this.fetcher(route, { cache: 'no-store', signal, ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }) });
      value = await response.json();
    } catch { throw new ConsoleError(0); }
    if (!response.ok) {
      let snapshot;
      try { if (value.snapshot) snapshot = validateSnapshot(value.snapshot); } catch { /* No fabricated state. */ }
      throw new ConsoleError(response.status, value.error?.code, snapshot);
    }
    if (pending) return { status: response.status, data: value };
    return value;
  }
  async catalog() {
    const value = await this.request('/api/sdk/catalog');
    if (!Array.isArray(value) || value.some(p => typeof p.id !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.options))) throw new ConsoleError(502, 'INVALID_RESPONSE');
    return value;
  }
  async matches() {
    const value = await this.request('/api/sdk/matches');
    if (!Array.isArray(value)) throw new ConsoleError(502, 'INVALID_RESPONSE');
    return value.map(validateSnapshot);
  }
  async snapshot(id) { return validateSnapshot(await this.request('/api/sdk/matches/' + encodeURIComponent(id))); }
  async create(gameId, options) { return validateSnapshot(await this.request('/api/sdk/matches', { body: { gameId, options } })); }
  async finish(id) { return validateSnapshot(await this.request('/api/sdk/matches/' + encodeURIComponent(id) + '/finish', { body: { reason: 'user_finished' } })); }
  async results(id, signal) {
    const result = await this.request('/api/sdk/matches/' + encodeURIComponent(id) + '/results', { signal, pending: true });
    const value = result.data;
    if (result.status === 202 ? value?.status !== 'pending' : result.status !== 200 || value?.matchId !== id
      || typeof value.gameId !== 'string' || !['open', 'closed'].includes(value.state)
      || !Array.isArray(value.metrics) || !Array.isArray(value.patterns)) throw new ConsoleError(502, 'INVALID_RESPONSE');
    return result;
  }
  async dashboard(signal) {
    const value = await this.request('/api/dashboard', { signal });
    const counts = o => o && ['started','active','finished','events'].every(k => Number.isSafeInteger(o[k]) && o[k] >= 0);
    if (!counts(value.totals) || !Array.isArray(value.games) || value.games.some(g => typeof g.gameId !== 'string' || !counts(g) || !Array.isArray(g.metrics))) throw new ConsoleError(502, 'INVALID_RESPONSE');
    return { status: 200, data: value };
  }
}
