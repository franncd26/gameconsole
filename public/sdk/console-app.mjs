import { ConsoleAPI, ConsoleError } from './console-api.mjs';
import { PollResource } from './console-stats.mjs';
import { CatalogView, MatchWorkspace, StatsPanel, element } from './console-views.mjs';
import { HostBridge } from './bridge/host-bridge.mjs';

export class ConsoleApp {
  constructor({ document, window, api = new ConsoleAPI(), bridge, clock = globalThis }) {
    Object.assign(this, { document, window, api });
    this.catalog = new Map(); this.snapshots = new Map(); this.rows = new Map();
    this.creating = new Set(); this.finishing = new Set(); this.selectedId = null;
    this.selection = 0; this.disposed = false;
    this.notice = document.getElementById('notice'); this.list = document.getElementById('match-list');
    this.bridge = bridge || new HostBridge({ window, onStatus: event => this.workspace?.status(event) });
    const onError = error => this.error(error);
    this.workspace = new MatchWorkspace({ document, root: document.getElementById('workspace'), bridge: this.bridge,
      onSelect: id => void this.select(id), onFinish: id => void this.finish(id), onError });
    this.library = new CatalogView({ document, root: document.getElementById('catalog'), onError,
      onCreate: (id, options) => this.create(id, options), onOpen: id => this.select(id), onFinish: id => this.finish(id) });
    this.stats = new StatsPanel({ document, results: document.getElementById('results'), dashboard: document.getElementById('dashboard'),
      resultStatus: document.getElementById('result-status'), dashboardStatus: document.getElementById('dashboard-status') });
    const common = { clock, hidden: () => document.hidden };
    this.results = new PollResource({ ...common, interval: 3000, task: (id, signal) => api.results(id, signal) });
    this.dashboard = new PollResource({ ...common, interval: 5000, task: (_key, signal) => api.dashboard(signal) });
    this.sessions = new PollResource({ ...common, interval: 5000, task: async () => ({ status: 200, data: await api.matches() }) });
    this.unsubscribers = [this.results.subscribe(s => this.stats.renderResults(s)), this.dashboard.subscribe(s => this.stats.renderDashboard(s)),
      this.sessions.subscribe(s => {
        if (s.status === 'updated') this.reconcile(s.data);
        document.getElementById('sessions-status').textContent = s.status === 'failed' ? 'Listado SDK no disponible; vuelve a actualizar.' : s.lastSuccess ? 'Partidas del proceso SDK · consulta ' + s.lastSuccess : 'Consultando partidas del servidor…';
      })];
    this.listeners = [];
    this.listen(document.getElementById('reload-catalog'), 'click', () => void this.loadCatalog());
    this.listen(document.getElementById('reload-stats'), 'click', () => { void this.results.refresh(); void this.dashboard.refresh(); });
    this.listen(document.getElementById('reload-matches'), 'click', () => void this.sessions.refresh());
    this.listen(document, 'visibilitychange', () => { for (const resource of [this.results, this.dashboard, this.sessions]) resource.visibilityChanged(); });
    this.listen(window, 'pagehide', () => this.dispose());
  }
  listen(node, type, callback) { node.addEventListener(type, callback); this.listeners.push(() => node.removeEventListener(type, callback)); }
  error(error) {
    if (this.disposed) return;
    this.notice.textContent = error instanceof ConsoleError ? error.message : 'Operación no completada. Consulta el estado y vuelve a intentarlo.';
  }
  async init() {
    const requested = new URLSearchParams(this.window.location.search).get('match');
    if (requested) this.selectedId = requested;
    void this.dashboard.setKey('dashboard');
    await this.loadCatalog();
    if (this.disposed) return;
    await this.sessions.setKey('matches');
    if (requested) await this.select(requested);
  }
  async loadCatalog() {
    if (this.catalogBusy || this.disposed) return;
    this.catalogBusy = true;
    try {
      const catalog = await this.api.catalog(); if (this.disposed) return;
      this.catalog = new Map(catalog.map(p => [p.id, p])); this.library.render(catalog);
      this.library.setMatches([...this.snapshots.values()]); this.stats.setCatalog(catalog);
      this.stats.renderDashboard(this.dashboard.state);
      this.notice.textContent = catalog.length ? 'Plugins confiables disponibles. Las reglas se ejecutan en el servidor.' : 'El catálogo autorizado no contiene plugins.';
    } catch (error) { this.error(error); }
    finally { this.catalogBusy = false; }
  }
  accept(snapshot) {
    if (this.disposed) return;
    const previous = this.snapshots.get(snapshot.matchId);
    const rank = { running: 0, closing: 1, finished: 2 };
    if (previous && (snapshot.gameId !== previous.gameId || snapshot.version < previous.version
      || (snapshot.version === previous.version && rank[snapshot.state] < rank[previous.state]))) return;
    this.snapshots.set(snapshot.matchId, structuredClone(snapshot));
    const d = this.document, name = this.catalog.get(snapshot.gameId)?.name || snapshot.gameId;
    let row = this.rows.get(snapshot.matchId);
    if (!row) {
      const node = element(d, 'li'), select = element(d, 'button'), detail = element(d, 'p', 'metadata');
      select.type = 'button'; select.addEventListener('click', () => void this.select(snapshot.matchId));
      const link = element(d, 'a', '', 'Nueva pestaña'); link.href = '/?match=' + encodeURIComponent(snapshot.matchId); link.target = '_blank'; link.rel = 'noopener';
      node.append(select, detail, link); this.list.append(node); row = { node, select, detail }; this.rows.set(snapshot.matchId, row);
    }
    row.select.textContent = name; row.select.setAttribute('aria-pressed', String(snapshot.matchId === this.selectedId));
    row.detail.textContent = snapshot.gameId + ' · ' + snapshot.matchId + ' · ' + snapshot.state + ' · v' + snapshot.version
      + (snapshot.delivery ? ' · Outbox: ' + snapshot.delivery.pending + ' pendientes / ' + snapshot.delivery.delivered + ' entregados' : '');
    this.workspace.upsert(snapshot, name);
    this.library.setMatches([...this.snapshots.values()]);
    if (previous?.state !== 'finished' && snapshot.state === 'finished' && this.selectedId === snapshot.matchId) void this.results.setKey(snapshot.matchId);
  }
  reconcile(snapshots) {
    if (this.disposed) return;
    const available = new Set(snapshots.map(s => s.matchId));
    for (const id of this.snapshots.keys()) if (!available.has(id)) {
      this.snapshots.delete(id); this.rows.get(id)?.node.remove(); this.rows.delete(id); this.workspace.unmount(id);
      const record = this.workspace.records.get(id);
      if (record) { record.channel.textContent = 'Partida ya no disponible en este proceso.'; record.finish.disabled = true; }
    }
    for (const snapshot of snapshots) this.accept(snapshot);
    this.library.setMatches([...this.snapshots.values()]);
    if (!this.selectedId && snapshots.length) void this.select(snapshots[0].matchId);
  }
  async create(gameId, options) {
    if (this.disposed || this.creating.has(gameId)) return;
    this.creating.add(gameId); this.library.setBusy(gameId, true);
    try {
      const snapshot = await this.api.create(gameId, options); if (this.disposed) return;
      this.accept(snapshot); await this.select(snapshot.matchId); void this.sessions.refresh();
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
      this.accept(snapshot); this.workspace.open(this.snapshots.get(id), this.catalog.get(snapshot.gameId).name);
      for (const [key, row] of this.rows) row.select.setAttribute('aria-pressed', String(key === id));
      this.window.history?.replaceState(null, '', this.window.location.pathname + '?match=' + encodeURIComponent(id));
      this.document.getElementById('selected-title').textContent = this.catalog.get(snapshot.gameId).name + ' · ' + id;
    } catch (error) { if (generation === this.selection) this.error(error); }
  }
  async finish(id) {
    if (!id || this.disposed || this.finishing.has(id)) return;
    this.finishing.add(id); this.workspace.setFinishing(id, true); this.library.setFinishing(id, true);
    try { this.accept(await this.api.finish(id)); }
    catch (error) {
      this.error(error);
      if (error.snapshot) this.accept(error.snapshot);
      // A failed HTTP response does not establish whether MATCH_FINISHED was accepted.
      try {
        const current = await this.api.snapshot(id); this.accept(current);
        if (!this.disposed) this.notice.textContent = current.state === 'finished'
          ? 'La respuesta de cierre falló; el snapshot confirma finished. No se repetirá el cierre automáticamente.'
          : current.state === 'closing' ? 'Cierre pendiente de aceptación. Puedes reintentar el cierre explícitamente.'
          : 'El snapshot continúa running. Puedes reintentar el cierre explícitamente.';
      } catch { if (!this.disposed) this.notice.textContent = 'Resultado del cierre desconocido. Consulta el estado antes de reintentar; no se presume rollback.'; }
    } finally {
      this.finishing.delete(id); if (!this.disposed) {
        this.workspace.setFinishing(id, false); this.library.setFinishing(id, false);
        if (this.selectedId === id) void this.results.setKey(id);
        void this.dashboard.setKey('dashboard'); void this.sessions.refresh();
      }
    }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.selection++;
    for (const resource of [this.results, this.dashboard, this.sessions]) resource.dispose();
    for (const unsubscribe of this.unsubscribers) unsubscribe(); for (const remove of this.listeners) remove();
    this.workspace.dispose(); this.bridge.dispose(); this.library.dispose(); this.list.replaceChildren(); this.rows.clear();
  }
}
