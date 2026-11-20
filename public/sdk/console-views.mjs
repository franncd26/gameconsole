import { ConsoleError } from './console-api.mjs';

export function element(document, tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
export const shortId = id => id.length > 16 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
const lifecycle = { running: 'En juego', closing: 'Cerrando', finished: 'Finalizada' };
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
      const players = plugin.players.min === plugin.players.max ? String(plugin.players.max) : plugin.players.min + '–' + plugin.players.max;
      card.append(element(d, 'p', 'metadata', players + ' participantes' + (plugin.capabilities.ai ? ' · Rival de IA' : '') + ' · ' + (plugin.capabilities.multipleInstances ? 'Puedes crear varias partidas' : 'Una partida en juego')));
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
  constructor({ document, root, historyRoot = root, empty, bridge, onSelect, onFinish, onError, clock = globalThis, onChange = () => {}, onTakeControl = () => {} }) {
    Object.assign(this, { document, root, historyRoot, empty, bridge, onSelect, onFinish, onError, clock, onChange, onTakeControl });
    this.records = new Map(); this.mode = 'focus'; this.selectedId = null;
  }
  upsert(snapshot, name) {
    const record = this.records.get(snapshot.matchId); if (!record) return;
    const rank = { running: 0, closing: 1, finished: 2 };
    if (snapshot.gameId !== record.snapshot.gameId || snapshot.version < record.snapshot.version
      || (snapshot.version === record.snapshot.version && rank[snapshot.state] < rank[record.snapshot.state])) return;
    // Only spectators need polled domain updates. An owner's action already reads its
    // snapshot; a redundant read could race it and produce BRIDGE_BUSY unnecessarily.
    const changed = record.snapshot.state !== snapshot.state || record.observing && record.snapshot.version !== snapshot.version;
    record.snapshot = structuredClone(snapshot);
    record.title.textContent = name || snapshot.gameId;
    record.badge.textContent = lifecycle[snapshot.state];
    record.details.textContent = snapshot.gameId + ' · ' + snapshot.matchId + ' · ' + snapshot.state + ' · v' + snapshot.version;
    const delivery = snapshot.delivery;
    record.delivery.textContent = delivery ? 'Outbox: ' + delivery.pending + ' pendientes · ' + delivery.delivered + ' entregados' + (delivery.error ? ' · entrega con error' : '') : 'Entrega pendiente de consulta';
    record.finish.disabled = snapshot.state === 'finished' || record.finishing;
    record.finish.textContent = snapshot.state === 'closing' ? 'Reintentar cierre' : 'Finalizar';
    record.remount.disabled = snapshot.state === 'finished';
    record.choose.textContent = snapshot.state === 'finished' ? 'Ver resultados' : 'Elegir';
    record.official.textContent = JSON.stringify(snapshot, null, 2);
    if (changed) { record.refreshRevision++; record.needsRefresh = true; }
    if (record.needsRefresh && record.frame) void this.refresh(record);
    if (snapshot.state === 'finished') this.complete(record);
    this.onChange();
  }
  async refresh(record) {
    if (record.refreshing || !record.frame) return;
    const frame = record.frame, generation = record.generation, matchId = record.snapshot.matchId;
    const active = () => this.records.get(matchId) === record && record.frame === frame && record.generation === generation;
    record.refreshing = true;
    try {
      do {
        const revision = record.refreshRevision;
        const sent = await this.bridge.refresh(frame);
        if (!active()) return;
        // A successful older read cannot acknowledge a later lifecycle change.
        record.needsRefresh = !sent || revision !== record.refreshRevision;
        if (!sent) {
          record.channel.textContent = 'Refresco pendiente; se reintentará al actualizar el listado.';
          break; // Persistent failure waits for polling/manual update, never a tight retry loop.
        }
      } while (record.needsRefresh);
    } catch {
      if (active()) { record.needsRefresh = true; record.channel.textContent = 'Esperando Bridge; se reintentará el refresco o puedes montar una interfaz nueva.'; }
    } finally { if (active()) record.refreshing = false; }
  }
  open(snapshot, name) {
    let record = this.records.get(snapshot.matchId);
    if (!record) {
      const d = this.document, card = element(d, 'article', 'match-card'), title = element(d, 'h3'), details = element(d, 'p', 'identity');
      const delivery = element(d, 'p', 'metadata'), channel = element(d, 'p', 'metadata', 'Esperando Bridge'), tools = element(d, 'div', 'tools'), container = element(d, 'div', 'frame-container');
      const badge = element(d, 'span', 'badge'), banner = element(d, 'p', 'terminal-banner'), official = element(d, 'pre');
      const diagnostics = element(d, 'details', 'diagnostics'); diagnostics.append(element(d, 'summary', '', 'Diagnóstico'), details, delivery, channel, official);
      record = { card, title, details, delivery, channel, container, badge, banner, official, tools, frame: null, snapshot: structuredClone(snapshot), finishing: false,
        generation: 0, refreshRevision: 0, refreshing: false, needsRefresh: false, retired: false, terminalTimer: null };
      record.finish = button(d, 'Finalizar', () => void this.onFinish(snapshot.matchId));
      const newTab = element(d, 'a', 'button', 'Nueva pestaña'); newTab.href = '/?match=' + encodeURIComponent(snapshot.matchId); newTab.target = '_blank'; newTab.rel = 'noopener';
      newTab.title = 'Abre esta misma partida en otra pestaña, sin crear otra instancia';
      record.choose = button(d, 'Elegir', () => this.onSelect(snapshot.matchId));
      record.remount = button(d, 'Restablecer vista', () => { if (record.snapshot.state !== 'finished') { this.unmount(snapshot.matchId); void this.onSelect(snapshot.matchId); } });
      const detach = button(d, 'Ocultar vista', () => record.snapshot.state === 'finished' ? this.retire(record) : this.unmount(snapshot.matchId));
      tools.append(record.choose, newTab, record.finish);
      record.control = element(d, 'p', 'control-state');
      record.claim = button(d, 'Tomar control', () => this.onTakeControl(snapshot.matchId)); record.claim.hidden = true;
      tools.append(record.claim);
      diagnostics.append(detach, record.remount);
      card.append(title, badge, tools, banner, container, diagnostics, record.control); this.root.append(card); this.records.set(snapshot.matchId, record);
      record.keyboard = element(d, 'p', 'keyboard-indicator'); record.keyboard.setAttribute('role', 'status');
      record.summary = element(d, 'section', 'grid-summary'); record.summary.hidden = this.mode !== 'grid';
      const resultStatus = element(d, 'p'), results = element(d, 'div');
      record.summary.append(element(d, 'h4', '', 'Estadísticas de esta partida'), resultStatus, results);
      record.analytics = new StatsPanel({ document: d, results, resultStatus });
      card.append(record.keyboard, record.summary);
    }
    this.upsert(snapshot, name);
    if (!record.frame && record.snapshot.state !== 'finished') {
      try {
        record.frame = this.bridge.mount(record.container, record.snapshot); record.needsRefresh = false;
        const mounted = record.frame;
        mounted.addEventListener('focus', () => { if (record.frame === mounted && !record.retired && !record.card.hidden) this.markKeyboard(snapshot.matchId); });
      }
      catch { record.channel.textContent = 'No se pudo montar. Revisa el límite de 32 canales del Bridge y desmonta una vista.'; }
    }
    this.select(snapshot.matchId); return record;
  }
  setMode(mode) {
    if (!['focus', 'grid'].includes(mode)) return;
    this.mode = mode; this.root.classList.toggle('grid', mode === 'grid'); this.visibility();
  }
  select(id) { this.selectedId = id; this.visibility(); }
  markKeyboard(id) {
    this.keyboardId = id;
    for (const [key, r] of this.records) {
      r.card.classList.toggle('keyboard-target', key === id);
      if (r.keyboard) r.keyboard.textContent = key === id ? 'Teclado aquí · Ctrl + Alt + J / K para cambiar' : '';
    }
  }
  focus(id) {
    const r = this.records.get(id);
    if (!r?.frame || r.card.hidden || r.snapshot.state !== 'running') return false;
    this.select(id); this.markKeyboard(id);
    r.frame.focus?.(); r.frame.contentWindow?.focus?.(); return true;
  }
  renderSummary(id, frame, state) {
    const r = this.records.get(id);
    if (!r || r.frame !== frame || r.retired) return;
    if (state.data && (state.data.matchId !== id || state.data.gameId !== r.snapshot.gameId)) return;
    r.analytics.renderResults(state);
  }
  visibility() {
    let visible = false;
    for (const [id, record] of this.records) {
      record.card.classList.toggle('selected', id === this.selectedId);
      record.card.hidden = record.retired ? id !== this.selectedId : this.mode === 'focus' && id !== this.selectedId;
      record.summary.hidden = this.mode !== 'grid' || record.retired;
      if (!record.retired && !record.card.hidden) visible = true;
    }
    if (this.empty) this.empty.hidden = visible;
    this.onChange();
  }
  control(id, state) {
    const r = this.records.get(id); if (!r) return;
    r.observing = !state.canControl;
    r.control.textContent = !state.supported ? 'Control local: este navegador no garantiza exclusividad entre pestañas.'
      : state.canControl ? 'Control en esta pestaña' : state.pending ? 'Esperando transferencia de control…' : 'Modo observador · otra pestaña puede controlar esta partida';
    r.claim.hidden = state.canControl || !state.supported;
    r.claim.textContent = state.pending ? 'Cancelar solicitud' : 'Tomar control';
  }
  complete(record) {
    record.banner.textContent = 'Partida finalizada. Sus resultados permanecen disponibles en el historial.';
    if (record.retired || record.terminalTimer !== null) return;
    if (!record.frame) { this.retire(record); return; }
    // Briefly keep the plugin's own terminal screen. Never finish the SDK a second time.
    const generation = record.generation;
    record.terminalTimer = this.clock.setTimeout(() => {
      record.terminalTimer = null;
      if (this.records.get(record.snapshot.matchId) === record && record.generation === generation) this.retire(record);
    }, 1800);
  }
  retire(record) {
    if (this.records.get(record.snapshot.matchId) !== record) return;
    this.unmount(record.snapshot.matchId); record.retired = true;
    record.channel.textContent = 'Canal liberado. La sesión y sus estadísticas se conservan en el servidor.';
    // Reparent only after releasing/removing the iframe; live frames never change parent.
    if (record.card.parentNode !== this.historyRoot) this.historyRoot.append(record.card);
    this.visibility();
  }
  setFinishing(id, value) { const r = this.records.get(id); if (r) { r.finishing = value; r.finish.disabled = value || r.snapshot.state === 'finished'; } }
  status(event) {
    const r = this.records.get(event.matchId); if (!r || r.retired) return;
    r.channel.textContent = event.state === 'initialized' ? 'Bridge conectado' : event.state === 'error' ? 'Bridge requiere atención; consulta el estado o remonta la vista.' : 'Bridge: ' + event.state;
    if (event.state === 'initialized' && r.needsRefresh) void this.refresh(r);
  }
  unmount(id) {
    const r = this.records.get(id); if (!r) return;
    if (r.terminalTimer !== null) this.clock.clearTimeout(r.terminalTimer);
    r.terminalTimer = null;
    const frame = r.frame;
    if (this.keyboardId === id) this.markKeyboard(null);
    r.frame = null; r.generation++; r.refreshing = false; r.needsRefresh = false;
    if (frame) { this.bridge.unmount(frame); r.channel.textContent = 'Vista desmontada; la partida permanece en el servidor.'; }
    this.onChange();
  }
  remove(id) {
    const r = this.records.get(id); if (!r) return;
    this.unmount(id); this.records.delete(id); r.card.remove();
  }
  dispose() { for (const id of this.records.keys()) this.unmount(id); this.records.clear(); this.root.replaceChildren(); if (this.historyRoot !== this.root) this.historyRoot.replaceChildren(); }
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
      item.append(element(d, 'p', 'metadata', [row.unit, { provisional: 'En curso', final: 'Final', unavailable: 'No disponible', invalid: 'Dato inválido' }[row.status] || row.status].filter(Boolean).join(' · ')));
      const info = element(d, 'details', 'diagnostics'); info.append(element(d, 'summary', '', 'Procedencia y detalles'));
      const metadata = [row.scope, row.subjectId, row.unit, row.status].filter(v => v !== undefined).join(' · ');
      info.append(element(d, 'p', 'metadata', metadata));
      if (row.reason) item.append(element(d, 'p', 'warning', 'Motivo: ' + row.reason));
      if (row.basis?.eventCount !== undefined) info.append(element(d, 'p', 'metadata', 'Base: ' + row.basis.eventCount + ' eventos'));
      if (row.source) info.append(element(d, 'pre', 'metadata', displayValue(row.source)));
      if (row.invalidSamples > 0) item.append(element(d, 'p', 'warning', 'Total parcial: ' + row.invalidSamples + ' muestras inválidas/no disponibles'));
      if (pattern && row.occurrences) info.append(element(d, 'pre', 'metadata', displayValue(row.occurrences)));
      item.append(info);
      root.append(item);
    }
  }
  renderResults(state) {
    const expanded = this.more?.open || false;
    this.status(this.resultStatus, state); this.results.replaceChildren();
    if (!state.data) return;
    const value = state.data;
    this.results.append(element(this.document, 'p', 'identity', value.gameId + ' · ' + value.matchId + ' · ' + value.state));
    if (state.status !== 'updated') this.results.append(element(this.document, 'p', 'warning', 'Datos de la última consulta; pueden estar desactualizados.'));
    this.results.append(element(this.document, 'h3', '', 'Resumen de la partida')); this.rows(this.results, value.metrics.slice(0, 3));
    const all = element(this.document, 'details', 'diagnostics'); all.open = expanded; this.more = all;
    all.append(element(this.document, 'summary', '', 'Más métricas y patrones'));
    this.rows(all, value.metrics.slice(3)); this.rows(all, value.patterns, true); this.results.append(all);
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
