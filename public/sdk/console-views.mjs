import { ConsoleError } from './console-api.mjs';

export function element(document, tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(document, text, action) {
  const node = element(document, 'button', '', text); node.type = 'button';
  node.addEventListener('click', action); return node;
}
export function optionControl(document, definition) {
  const { type, values, default: initial } = definition;
  const control = element(document, type === 'enum' || values ? 'select' : 'input');
  if (values) for (const value of values) {
    const item = element(document, 'option', '', value); item.value = String(value); control.append(item);
  }
  if (type === 'boolean') { control.type = 'checkbox'; control.checked = initial; }
  else {
    control.value = String(initial); control.required = true;
    if (type === 'integer' && !values) { control.type = 'number'; control.min = definition.min; control.max = definition.max; control.step = '1'; }
    if (type === 'string') { control.type = 'text'; control.minLength = definition.minLength; control.maxLength = definition.maxLength; }
  }
  const read = () => {
    const value = type === 'boolean' ? control.checked : type === 'integer' ? Number(control.value) : control.value;
    if (!control.checkValidity() || (type !== 'boolean' && !control.value.length)
      || (values && !values.includes(value)) || (type === 'integer' && !Number.isSafeInteger(value))) throw new ConsoleError(400, 'INVALID_OPTIONS');
    return value;
  };
  return { control, read };
}

export class CatalogView {
  constructor({ document, root, onCreate, onOpen, onFinish, onError }) {
    Object.assign(this, { document, root, onCreate, onOpen, onFinish, onError }); this.cards = new Map();
  }
  render(catalog) {
    this.root.replaceChildren(); this.cards.clear();
    for (const plugin of catalog) {
      const d = this.document, card = element(d, 'article', 'catalog-card'), form = element(d, 'form');
      card.append(element(d, 'p', 'eyebrow', plugin.category), element(d, 'h3', '', plugin.name), element(d, 'p', 'muted', plugin.description));
      card.append(element(d, 'p', 'metadata', plugin.players.min + '–' + plugin.players.max + ' participantes · ' + (plugin.capabilities.multipleInstances ? 'Múltiples instancias' : 'Una partida sin finalizar por tipo')));
      const controls = new Map();
      for (const definition of plugin.options) {
        const label = element(d, 'label', 'option', definition.label), input = optionControl(d, definition);
        label.append(input.control); form.append(label); controls.set(definition.id, input);
      }
      const submit = element(d, 'button', 'primary', 'Crear partida'); submit.type = 'submit';
      const record = { plugin, card, controls, submit, existing: null, busy: false };
      const finish = button(d, 'Finalizar la existente', () => void this.onFinish(record.existing)); finish.hidden = true;
      record.finish = finish;
      form.addEventListener('submit', (event) => {
        event.preventDefault(); if (record.busy) return;
        if (record.existing) { void this.onOpen(record.existing); return; }
        try { void this.onCreate(plugin.id, Object.fromEntries([...controls].map(([id, input]) => [id, input.read()]))); }
        catch (error) { this.onError(error); }
      });
      form.append(submit, finish); card.append(form); this.root.append(card); this.cards.set(plugin.id, record);
    }
  }
  setMatches(snapshots) {
    for (const record of this.cards.values()) {
      record.existing = record.plugin.capabilities.multipleInstances ? null : snapshots.find(s => s.gameId === record.plugin.id && s.state !== 'finished')?.matchId || null;
      record.submit.textContent = record.existing ? 'Abrir partida existente' : 'Crear partida';
      record.finish.hidden = !record.existing;
    }
  }
  setBusy(id, busy) { const r = this.cards.get(id); if (r) { r.busy = busy; r.submit.disabled = busy; r.submit.textContent = busy ? 'Creando…' : r.existing ? 'Abrir partida existente' : 'Crear partida'; } }
  setFinishing(id, busy) { for (const r of this.cards.values()) if (r.existing === id) { r.finish.disabled = busy; r.finish.textContent = busy ? 'Cerrando…' : 'Finalizar la existente'; } }
  dispose() { this.root.replaceChildren(); this.cards.clear(); }
}

export class MatchWorkspace {
  constructor({ document, root, bridge, onSelect, onFinish, onError }) {
    Object.assign(this, { document, root, bridge, onSelect, onFinish, onError }); this.records = new Map();
  }
  upsert(snapshot, name) {
    const record = this.records.get(snapshot.matchId); if (!record) return;
    if (snapshot.version < record.snapshot.version) return;
    const changed = record.snapshot.state !== snapshot.state;
    record.snapshot = structuredClone(snapshot);
    record.title.textContent = name || snapshot.gameId;
    record.details.textContent = snapshot.gameId + ' · ' + snapshot.matchId + ' · ' + snapshot.state + ' · v' + snapshot.version;
    const delivery = snapshot.delivery;
    record.delivery.textContent = delivery ? 'Outbox: ' + delivery.pending + ' pendientes · ' + delivery.delivered + ' entregados' + (delivery.error ? ' · entrega con error' : '') : 'Entrega pendiente de consulta';
    record.finish.disabled = snapshot.state === 'finished' || record.finishing;
    record.finish.textContent = snapshot.state === 'closing' ? 'Reintentar cierre' : 'Finalizar';
    if (changed) record.needsRefresh = true;
    if (record.needsRefresh && record.frame) void this.refresh(record);
  }
  async refresh(record) {
    if (record.refreshing || !record.frame) return;
    const frame = record.frame; record.refreshing = true;
    try {
      const sent = await this.bridge.refresh(frame);
      if (record.frame !== frame) return;
      record.needsRefresh = !sent;
      if (!sent) record.channel.textContent = 'Refresco pendiente; se reintentará al actualizar el listado.';
    } catch {
      if (record.frame === frame) { record.needsRefresh = true; record.channel.textContent = 'Esperando Bridge; se reintentará el refresco o puedes montar una interfaz nueva.'; }
    } finally { record.refreshing = false; }
  }
  open(snapshot, name) {
    let record = this.records.get(snapshot.matchId);
    if (!record) {
      const d = this.document, card = element(d, 'article', 'match-card'), title = element(d, 'h3'), details = element(d, 'p', 'identity');
      const delivery = element(d, 'p', 'metadata'), channel = element(d, 'p', 'metadata', 'Esperando Bridge'), tools = element(d, 'div', 'tools'), container = element(d, 'div', 'frame-container');
      record = { card, title, details, delivery, channel, container, frame: null, snapshot: structuredClone(snapshot), finishing: false };
      record.finish = button(d, 'Finalizar', () => void this.onFinish(snapshot.matchId));
      const newTab = element(d, 'a', 'button', 'Nueva pestaña'); newTab.href = '/?match=' + encodeURIComponent(snapshot.matchId); newTab.target = '_blank'; newTab.rel = 'noopener';
      tools.append(button(d, 'Seleccionar', () => this.onSelect(snapshot.matchId)), newTab, record.finish,
        button(d, 'Desmontar vista', () => this.unmount(snapshot.matchId)),
        button(d, 'Remontar vista', () => { this.unmount(snapshot.matchId); void this.onSelect(snapshot.matchId); }));
      card.append(title, details, delivery, channel, tools, container); this.root.append(card); this.records.set(snapshot.matchId, record);
    }
    this.upsert(snapshot, name);
    if (!record.frame) {
      try { record.frame = this.bridge.mount(record.container, record.snapshot); record.needsRefresh = false; }
      catch { record.channel.textContent = 'No se pudo montar. Revisa el límite de 32 canales del Bridge y desmonta una vista.'; }
    }
    this.select(snapshot.matchId); return record;
  }
  select(id) { for (const [key, record] of this.records) record.card.classList.toggle('selected', key === id); }
  setFinishing(id, value) { const r = this.records.get(id); if (r) { r.finishing = value; r.finish.disabled = value || r.snapshot.state === 'finished'; } }
  status(event) {
    const r = this.records.get(event.matchId); if (!r) return;
    r.channel.textContent = event.state === 'initialized' ? 'Bridge conectado' : event.state === 'error' ? 'Bridge requiere atención; consulta el estado o remonta la vista.' : 'Bridge: ' + event.state;
    if (event.state === 'initialized' && r.needsRefresh) void this.refresh(r);
  }
  unmount(id) { const r = this.records.get(id); if (r?.frame) { this.bridge.unmount(r.frame); r.frame = null; r.channel.textContent = 'Vista desmontada; la partida permanece en el servidor.'; } }
  dispose() { for (const id of this.records.keys()) this.unmount(id); this.records.clear(); this.root.replaceChildren(); }
}

export function displayValue(value) { return value === null ? 'Sin dato (null)' : value === undefined ? 'Sin datos' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }
const countLabels = { started: 'Instancias iniciadas', active: 'Activas', finished: 'Finalizadas', events: 'Eventos recibidos' };
export class StatsPanel {
  constructor({ document, results, dashboard, resultStatus, dashboardStatus }) { Object.assign(this, { document, results, dashboard, resultStatus, dashboardStatus }); this.catalog = []; }
  setCatalog(catalog) { this.catalog = structuredClone(catalog); }
  status(node, state) {
    const names = { idle: 'Selecciona una partida', pending: 'Entrega o análisis pendiente; no se muestran ceros sustitutos', loading: 'Consultando…', updated: 'Actualizado', failed: 'Estadísticas temporalmente indisponibles', suspended: 'Consultas suspendidas: pestaña oculta' };
    node.textContent = names[state.status] + (state.error ? ' · HTTP ' + state.error.status : '') + (state.lastSuccess ? ' · Última consulta correcta: ' + state.lastSuccess : '');
  }
  rows(root, rows, pattern = false) {
    for (const row of rows || []) {
      const d = this.document, item = element(d, 'article', 'metric');
      item.append(element(d, 'h4', '', row.label || row.id), element(d, 'pre', 'metric-value', displayValue(pattern ? row.count : row.value)));
      const metadata = [row.scope, row.subjectId, row.unit, row.status].filter(v => v !== undefined).join(' · ');
      item.append(element(d, 'p', 'metadata', metadata));
      if (row.reason) item.append(element(d, 'p', 'warning', 'Motivo: ' + row.reason));
      if (row.basis?.eventCount !== undefined) item.append(element(d, 'p', 'metadata', 'Base: ' + row.basis.eventCount + ' eventos'));
      if (row.source) item.append(element(d, 'pre', 'metadata', displayValue(row.source)));
      if (row.invalidSamples > 0) item.append(element(d, 'p', 'warning', 'Total parcial: ' + row.invalidSamples + ' muestras inválidas/no disponibles'));
      if (pattern && row.occurrences) item.append(element(d, 'pre', 'metadata', displayValue(row.occurrences)));
      root.append(item);
    }
  }
  renderResults(state) {
    this.status(this.resultStatus, state); this.results.replaceChildren();
    if (!state.data) return;
    const value = state.data;
    this.results.append(element(this.document, 'p', 'identity', value.gameId + ' · ' + value.matchId + ' · ' + value.state));
    if (state.status !== 'updated') this.results.append(element(this.document, 'p', 'warning', 'Datos de la última consulta; pueden estar desactualizados.'));
    this.results.append(element(this.document, 'h3', '', 'Métricas de la partida')); this.rows(this.results, value.metrics);
    this.results.append(element(this.document, 'h3', '', 'Patrones de la partida')); this.rows(this.results, value.patterns, true);
    if (!value.metrics.length && !value.patterns.length) this.results.append(element(this.document, 'p', 'muted', 'Sin resultados analíticos disponibles en este perfil.'));
  }
  renderDashboard(state) {
    this.status(this.dashboardStatus, state); this.dashboard.replaceChildren(); const d = this.document;
    if (state.data) {
      this.dashboard.append(element(d, 'p', 'metadata', [state.data.source, state.data.scope, state.data.consistency].filter(Boolean).join(' · ')));
      if (state.status !== 'updated') this.dashboard.append(element(d, 'p', 'warning', 'Últimos datos recibidos; no representan una consulta actualizada.'));
      const totals = element(d, 'div', 'totals');
      for (const [key, label] of Object.entries(countLabels)) totals.append(element(d, 'p', 'total', label + ': ' + displayValue(state.data.totals[key])));
      this.dashboard.append(totals);
    }
    const games = new Map(this.catalog.map(p => [p.id, { name: p.name }]));
    for (const game of state.data?.games || []) games.set(game.gameId, { ...games.get(game.gameId), data: game });
    for (const [id, value] of games) {
      const section = element(d, 'article', 'game-stats'); section.append(element(d, 'h3', '', value.name || id));
      if (!value.data) section.append(element(d, 'p', 'muted', 'Sin datos disponibles en GameStats'));
      else {
        for (const [key, label] of Object.entries(countLabels)) section.append(element(d, 'p', 'metadata', label + ': ' + displayValue(value.data[key])));
        this.rows(section, value.data.metrics);
      }
      this.dashboard.append(section);
    }
  }
}
