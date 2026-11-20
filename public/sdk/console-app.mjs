import { ConsoleAPI, ConsoleError } from './console-api.mjs';
import { PollResource } from './console-stats.mjs';
import { CatalogView, MatchWorkspace, StatsPanel, element, shortId } from './console-views.mjs';
import { HostBridge } from './bridge/host-bridge.mjs';
import { PresentationCoordinator, readPreferences, savePreferences } from './console-presentation.mjs';
import { GridResultsCoordinator } from './console-grid-stats.mjs';
import { navigationDirection } from './bridge/protocol.mjs';
import { PluginImportView } from './console-import.mjs';

export class ConsoleApp {
  constructor({ document, window, api = new ConsoleAPI(), bridge, clock = globalThis }) {
    Object.assign(this, { document, window, api });
    this.catalog = new Map(); this.snapshots = new Map(); this.rows = new Map();
    this.creating = new Set(); this.finishing = new Set(); this.selectedId = null;
    this.selection = 0; this.disposed = false;
    this.notice = document.getElementById('notice'); this.list = document.getElementById('match-list');
    this.historyList = document.getElementById('history-list');
    this.bridge = bridge || new HostBridge({ window, onStatus: event => this.workspace?.status(event),
      onNavigate: event => this.navigate(event.direction, event.matchId) });
    try { this.storage = window.localStorage; } catch { /* Optional host-only preferences. */ }
    this.preferences = readPreferences(this.storage);
    let channel;
    try { if (window.BroadcastChannel) channel = new window.BroadcastChannel('gameconsole.control.v1'); } catch { /* Web Locks still excludes competing owners. */ }
    this.presentation = new PresentationCoordinator({ bridge: this.bridge, locks: window.navigator?.locks, channel,
      onError: message => { this.notice.textContent = message; }, onChange: (id, control) => this.workspace?.control(id, control) });
    const onError = error => this.error(error);
    this.importView = new PluginImportView({ document, api, onInstalled: () => this.loadCatalog() });
    this.workspace = new MatchWorkspace({ document, root: document.getElementById('workspace'), bridge: this.bridge,
      historyRoot: document.getElementById('history-workspace'), empty: document.getElementById('workspace-empty'), clock,
      onSelect: id => void this.select(id), onFinish: id => void this.finish(id), onError,
      onChange: () => this.updatePresentation(), onTakeControl: id => this.presentation.take(id) });
    this.library = new CatalogView({ document, root: document.getElementById('catalog'), onError,
      onCreate: (id, options) => this.create(id, options), onOpen: id => this.select(id), onFinish: id => this.finish(id) });
    this.stats = new StatsPanel({ document, results: document.getElementById('results'), dashboard: document.getElementById('dashboard'),
      resultStatus: document.getElementById('result-status'), dashboardStatus: document.getElementById('dashboard-status') });
    this.gridResults = new GridResultsCoordinator({ api, clock, onUpdate: (id, frame, state) => this.workspace.renderSummary(id, frame, state) });
    const common = { clock, hidden: () => document.hidden };
    this.results = new PollResource({ ...common, interval: 3000, task: id => this.gridResults.fetch(id, this.snapshots.get(id)?.gameId) });
    this.dashboard = new PollResource({ ...common, interval: 5000, task: (_key, signal) => api.dashboard(signal) });
    this.sessions = new PollResource({ ...common, interval: 5000, task: async () => ({ status: 200, data: await api.matches() }) });
    this.unsubscribers = [this.results.subscribe(s => { this.stats.renderResults(s); this.gridResults.selected(s); }), this.dashboard.subscribe(s => this.stats.renderDashboard(s)),
      this.sessions.subscribe(s => {
        if (s.status === 'updated') this.reconcile(s.data);
        document.getElementById('sessions-status').textContent = s.status === 'failed' ? 'No pudimos actualizar tus partidas. Vuelve a intentarlo.' : s.lastSuccess ? 'Lista actualizada · ' + s.lastSuccess : 'Buscando tus partidas…';
      })];
    this.listeners = [];
    this.listen(document.getElementById('reload-catalog'), 'click', () => void this.loadCatalog());
    this.listen(document.getElementById('reload-stats'), 'click', () => { void this.results.refresh(); void this.dashboard.refresh(); });
    this.listen(document.getElementById('reload-matches'), 'click', () => void this.sessions.refresh());
    this.listen(document, 'visibilitychange', () => { for (const resource of [this.results, this.dashboard, this.sessions]) resource.visibilityChanged(); this.updatePresentation(); });
    this.listen(window, 'pagehide', () => this.dispose());
    this.listen(window, 'keydown', event => {
      const direction = navigationDirection(event);
      if (direction && this.navigate(direction)) event.preventDefault();
    });
    for (const section of ['library', 'play', 'analytics']) this.listen(document.getElementById('nav-' + section), 'click', () => this.setSection(section));
    for (const mode of ['focus', 'grid']) this.listen(document.getElementById('mode-' + mode), 'click', () => this.setMode(mode));
    for (const key of ['pauseWhenHidden', 'resumeWhenVisible']) {
      const input = document.getElementById(key); input.checked = this.preferences[key];
      this.listen(input, 'change', () => {
        this.preferences[key] = input.checked;
        const saved = savePreferences(this.storage, this.preferences);
        document.getElementById('preferences-status').textContent = saved ? 'Preferencias guardadas' : 'Preferencias activas en esta pestaña; no fue posible guardarlas.';
        this.updatePresentation();
      });
    }
    this.setSection('library'); this.setMode('focus');
  }
  setSection(section) {
    this.section = section;
    for (const id of ['library', 'play', 'analytics']) {
      this.document.getElementById(id).hidden = id !== section;
      this.document.getElementById('nav-' + id).setAttribute('aria-pressed', String(id === section));
    }
    this.updatePresentation();
  }
  updatePresentation() {
    if (!this.workspace || this.disposed) return;
    this.presentation.sync(this.workspace.records, { section: this.section, mode: this.workspace.mode,
      selectedId: this.workspace.selectedId, hidden: this.document.hidden, preferences: this.preferences });
    if (this.gridResults) {
      const views = new Map();
      if (this.section === 'play' && this.workspace.mode === 'grid' && !this.document.hidden) {
        for (const [id, r] of this.workspace.records) if (r.frame && !r.retired && !r.card.hidden) views.set(id, { frame: r.frame, gameId: r.snapshot.gameId });
      }
      this.gridResults.setViews(views, this.selectedId, { hidden: this.document.hidden });
    }
  }
  navigate(direction, sourceId = this.workspace.keyboardId || this.workspace.selectedId) {
    if (this.disposed || this.document.hidden || this.section !== 'play' || this.workspace.mode !== 'grid') return false;
    const ids = [...this.workspace.records].filter(([, r]) => r.frame && !r.card.hidden && !r.retired && r.snapshot.state === 'running').map(([id]) => id);
    if (!ids.length || (sourceId && !ids.includes(sourceId)) || !['previous', 'next'].includes(direction)) return false;
    const index = ids.indexOf(sourceId), id = ids[(index + (direction === 'next' ? 1 : -1) + ids.length) % ids.length];
    this.selection++; this.selectedId = id; this.workspace.focus(id);
    for (const [key, row] of this.rows) row.select.setAttribute('aria-pressed', String(key === id));
    this.document.getElementById('selected-title').textContent = this.name(this.snapshots.get(id)) + ' · ' + shortId(id);
    this.window.history?.replaceState(null, '', this.window.location.pathname + '?match=' + encodeURIComponent(id));
    void this.results.setKey(id); return true;
  }
  setMode(mode) {
    this.workspace.setMode(mode);
    for (const id of ['focus', 'grid']) this.document.getElementById('mode-' + id).setAttribute('aria-pressed', String(mode === id));
  }
  name(snapshot) {
    const siblings = [...this.snapshots.values()].filter(s => s.gameId === snapshot.gameId);
    return (this.catalog.get(snapshot.gameId)?.name || snapshot.gameId) + ' ' + (siblings.findIndex(s => s.matchId === snapshot.matchId) + 1);
  }
  listen(node, type, callback) { node.addEventListener(type, callback); this.listeners.push(() => node.removeEventListener(type, callback)); }
  error(error) {
    if (this.disposed) return;
    this.notice.textContent = error instanceof ConsoleError ? error.message : 'Operación no completada. Consulta el estado y vuelve a intentarlo.';
  }
  async init() {
    void this.importView.init();
    const requested = new URLSearchParams(this.window.location.search).get('match');
    if (requested) this.selectedId = requested;
    void this.dashboard.setKey('dashboard');
    await this.loadCatalog();
    if (this.disposed) return;
    await this.sessions.setKey('matches');
    if (requested) await this.select(requested);
  }
  async loadCatalog() {
    if (this.disposed) return;
    if (this.catalogBusy) { this.catalogAgain = true; return; }
    this.catalogBusy = true;
    try {
      const catalog = await this.api.catalog(); if (this.disposed) return;
      this.catalog = new Map(catalog.map(p => [p.id, p])); this.library.render(catalog);
      this.library.setMatches([...this.snapshots.values()]); this.stats.setCatalog(catalog);
      this.stats.renderDashboard(this.dashboard.state);
      this.notice.textContent = catalog.length ? 'Tu biblioteca está lista. Elige tu próximo juego.' : 'No hay juegos disponibles. Vuelve a actualizar la biblioteca.';
    } catch (error) { this.error(error); }
    finally { this.catalogBusy = false; if (this.catalogAgain) { this.catalogAgain = false; void this.loadCatalog(); } }
  }
  accept(snapshot) {
    if (this.disposed) return;
    const previous = this.snapshots.get(snapshot.matchId);
    const rank = { running: 0, closing: 1, finished: 2 };
    if (previous && (snapshot.gameId !== previous.gameId || snapshot.version < previous.version
      || (snapshot.version === previous.version && rank[snapshot.state] < rank[previous.state]))) return;
    this.snapshots.set(snapshot.matchId, structuredClone(snapshot));
    const d = this.document, name = this.name(snapshot);
    let row = this.rows.get(snapshot.matchId);
    if (!row) {
      const node = element(d, 'li'), select = element(d, 'button'), detail = element(d, 'p', 'metadata');
      select.type = 'button'; select.addEventListener('click', () => void this.select(snapshot.matchId));
      const link = element(d, 'a', '', 'Nueva pestaña'); link.href = '/?match=' + encodeURIComponent(snapshot.matchId); link.target = '_blank'; link.rel = 'noopener';
      link.title = 'Abre la misma partida; no crea otra instancia';
      node.append(select, detail, link); this.list.append(node); row = { node, select, detail }; this.rows.set(snapshot.matchId, row);
    }
    row.select.textContent = name; row.select.setAttribute('aria-pressed', String(snapshot.matchId === this.selectedId));
    row.select.setAttribute('aria-label', name + ' · ' + snapshot.matchId);
    row.detail.textContent = shortId(snapshot.matchId) + ' · ' + ({ running: 'En juego', closing: 'Cerrando', finished: 'Finalizada' }[snapshot.state]);
    const destination = snapshot.state === 'finished' ? this.historyList : this.list;
    if (row.node.parentNode !== destination) destination.append(row.node);
    this.workspace.upsert(snapshot, name);
    this.library.setMatches([...this.snapshots.values()]);
    if (previous?.state !== 'finished' && snapshot.state === 'finished') {
      this.notice.textContent = name + ' finalizó. Puedes consultar sus resultados en el historial.';
      if (this.selectedId === snapshot.matchId) void this.results.setKey(snapshot.matchId);
    }
  }
  reconcile(snapshots) {
    if (this.disposed) return;
    const available = new Set(snapshots.map(s => s.matchId));
    for (const id of this.snapshots.keys()) if (!available.has(id)) {
      this.snapshots.delete(id); this.rows.get(id)?.node.remove(); this.rows.delete(id); this.workspace.remove(id);
      if (this.selectedId === id) {
        this.selection++; this.selectedId = null; void this.results.setKey(null);
        this.document.getElementById('selected-title').textContent = 'Partida ya no disponible en este proceso.';
        this.window.history?.replaceState(null, '', this.window.location.pathname);
      }
    }
    for (const snapshot of snapshots) this.accept(snapshot);
    this.library.setMatches([...this.snapshots.values()]);
    const active = snapshots.find(s => s.state !== 'finished');
    if (!this.selectedId && active) void this.select(active.matchId);
  }
  async create(gameId, options) {
    if (this.disposed || this.creating.has(gameId)) return;
    this.creating.add(gameId); this.library.setBusy(gameId, true);
    try {
      const snapshot = await this.api.create(gameId, options); if (this.disposed) return;
      // A list requested before this confirmed creation must not remove the new match.
      void this.sessions.setKey('matches');
      this.accept(snapshot); await this.select(snapshot.matchId);
      this.workspace.records.get(snapshot.matchId)?.card.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      this.error(error);
      // Creation has no idempotency key. Always inspect the server, never retry automatically.
      await this.sessions.refresh();
      if (error.code === 'MULTIPLE_INSTANCES_DISABLED') {
        const existing = [...this.snapshots.values()].find(s => s.gameId === gameId && s.state !== 'finished');
        if (existing) await this.select(existing.matchId);
      }
    } finally { this.creating.delete(gameId); if (!this.disposed) this.library.setBusy(gameId, false); }
  }
  async select(id) {
    if (this.disposed) return;
    const generation = ++this.selection; this.selectedId = id;
    void this.results.setKey(id);
    try {
      const snapshot = await this.api.snapshot(id);
      if (this.disposed || generation !== this.selection) return;
      if (!this.catalog.has(snapshot.gameId)) throw new ConsoleError(404, 'UNKNOWN_MATCH');
      this.accept(snapshot); const current = this.snapshots.get(id);
      this.workspace.open(current, this.name(current)); this.setSection('play');
      if (current.state === 'finished') this.document.getElementById('history').open = true;
      for (const [key, row] of this.rows) row.select.setAttribute('aria-pressed', String(key === id));
      this.window.history?.replaceState(null, '', this.window.location.pathname + '?match=' + encodeURIComponent(id));
      this.document.getElementById('selected-title').textContent = this.name(current) + ' · ' + shortId(id);
    } catch (error) { if (generation === this.selection) this.error(error); }
  }
  async finish(id) {
    if (!id || this.disposed || this.finishing.has(id) || !this.snapshots.has(id)) return;
    const available = () => !this.disposed && this.snapshots.has(id);
    this.finishing.add(id); this.workspace.setFinishing(id, true); this.library.setFinishing(id, true);
    try { const snapshot = await this.api.finish(id); if (available()) this.accept(snapshot); }
    catch (error) {
      if (!available()) return;
      this.error(error);
      if (error.snapshot) this.accept(error.snapshot);
      // A failed HTTP response does not establish whether MATCH_FINISHED was accepted.
      try {
        const current = await this.api.snapshot(id); if (!available()) return; this.accept(current);
        if (!this.disposed) this.notice.textContent = current.state === 'finished'
          ? 'La respuesta de cierre falló; el snapshot confirma finished. No se repetirá el cierre automáticamente.'
          : current.state === 'closing' ? 'Cierre pendiente de aceptación. Puedes reintentar el cierre explícitamente.'
          : 'El snapshot continúa running. Puedes reintentar el cierre explícitamente.';
      } catch { if (available()) this.notice.textContent = 'Resultado del cierre desconocido. Consulta el estado antes de reintentar; no se presume rollback.'; }
    } finally {
      this.finishing.delete(id); if (available()) {
        this.workspace.setFinishing(id, false); this.library.setFinishing(id, false);
        if (this.selectedId === id) void this.results.setKey(id);
        void this.dashboard.setKey('dashboard'); void this.sessions.refresh();
      }
    }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.selection++;
    this.importView.dispose();
    for (const resource of [this.results, this.dashboard, this.sessions]) resource.dispose();
    this.gridResults.dispose();
    for (const unsubscribe of this.unsubscribers) unsubscribe(); for (const remove of this.listeners) remove();
    this.presentation.dispose(); this.workspace.dispose(); this.bridge.dispose(); this.library.dispose(); this.list.replaceChildren(); this.historyList.replaceChildren(); this.rows.clear();
  }
}
