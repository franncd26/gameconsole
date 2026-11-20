// Presentation controller only: snapshots and rules belong to the server.
export class GatoController {
  constructor({ bridge, view, window, document, clock = globalThis, id = () => globalThis.crypto.randomUUID() }) {
    Object.assign(this, { bridge, view, window, document, clock, id });
    this.snapshot = null; this.identity = null; this.connected = false;
    this.busy = false; this.disposed = false; this.uncertain = null; this.needsSync = true;
    this.active = !document.hidden;
    this.note = 'Esperando conexión con GameConsole…';
    this.unsubscribers = [
      bridge.onInit((value) => {
        if (this.disposed) return;
        this.identity = value; this.connected = true; this.needsSync = false; this.note = 'Conectado';
        this.adopt(value.snapshot); this.render();
      }),
      bridge.onSnapshot((snapshot) => this.adopt(snapshot)),
      bridge.onResult((result) => { this.lastOutcome = result.outcome; }),
      bridge.onError((error) => this.report(error)),
      bridge.onDetach(() => { this.connected = false; this.note = 'Desconectado. Remonta el iframe desde la consola.'; this.render(); this.dispose(); }),
    ];
    this.handlers = {
      blur: () => this.suspend(),
      focus: () => { this.active = !document.hidden; if (this.connected && this.needsSync) void this.sync(); else this.render(); },
      visibilitychange: () => { if (document.hidden) this.suspend(); else { this.active = true; if (this.connected && this.needsSync) void this.sync(); else this.render(); } },
      pagehide: () => this.dispose(),
    };
    for (const type of ['blur', 'focus', 'pagehide']) window.addEventListener(type, this.handlers[type]);
    document.addEventListener('visibilitychange', this.handlers.visibilitychange);
    view.bind({
      mark: (index) => void this.mark(index), retryAI: () => void this.retryAI(),
      sync: () => void this.sync(),
      replay: () => { if (this.uncertain) void this.act(this.uncertain.type, this.uncertain.payload, this.uncertain); },
    });
    this.render();
  }
  adopt(snapshot) {
    if (this.disposed || !snapshot) return;
    if (this.identity && (snapshot.matchId !== this.identity.matchId || snapshot.gameId !== this.identity.gameId)) return;
    if (this.snapshot && (snapshot.matchId !== this.snapshot.matchId || snapshot.version < this.snapshot.version)) return;
    this.snapshot = structuredClone(snapshot);
    this.render();
  }
  render() {
    if (!this.disposed) this.view.render({
      snapshot: this.snapshot ? structuredClone(this.snapshot) : null,
      connected: this.connected, busy: this.busy, uncertain: Boolean(this.uncertain), needsSync: this.needsSync,
      note: this.note, active: this.active,
    });
  }
  report(error) {
    if (this.disposed) return;
    this.needsSync = true;
    const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'BRIDGE_ERROR';
    this.note = code === 'RESULT_UNKNOWN' || error?.unknown
      ? 'Resultado desconocido. Consulta el estado o recupera la misma operación; no se reintentará automáticamente.'
      : 'No se pudo completar la solicitud (' + code + '). Consulta el estado.';
    if (['BRIDGE_DETACHED', 'BRIDGE_NOT_READY', 'BRIDGE_MESSAGE_TOO_LARGE', 'MESSAGE_TOO_LARGE'].includes(code)) this.connected = false;
    this.render();
  }
  async sync() {
    if (this.disposed || !this.connected || this.busy) return;
    this.busy = true; this.render();
    try { this.adopt(await this.bridge.requestSnapshot()); this.adopt(this.bridge.getSnapshot()); this.needsSync = false; return true; }
    catch (error) { this.report(error); return false; }
    finally { this.busy = false; this.render(); }
  }
  async act(type, payload, replay = null) {
    if (this.disposed || this.busy || !this.connected || this.snapshot?.state !== 'running' || ((this.uncertain || this.needsSync) && !replay)) return;
    const operation = replay || { type, payload: structuredClone(payload), messageId: this.id() };
    this.busy = true; this.needsSync = true; this.note = 'Procesando…'; this.render();
    let known = false;
    try {
      const result = await this.bridge.dispatch(operation.type, operation.payload, { messageId: operation.messageId });
      known = true; this.uncertain = null;
      if (this.disposed) return result;
      // ACTION_RESULT can be a replay of an older version. Never render its snapshot.
      this.note = result.outcome === 'completed' ? 'Acción confirmada'
        : result.outcome === 'dependency_failed' ? (result.committed ? 'Cambio confirmado; falló una dependencia. Consulta el estado para continuar.' : 'La dependencia falló; no hubo nuevos cambios.')
        : 'Acción rechazada (' + (result.error?.code || 'REJECTED') + ').';
      this.adopt(await this.bridge.requestSnapshot()); this.adopt(this.bridge.getSnapshot()); this.needsSync = false;
      return result;
    } catch (error) {
      if (!known && (error?.unknown || error?.code === 'RESULT_UNKNOWN')) this.uncertain = operation;
      this.report(error);
    } finally {
      this.busy = false; this.render();
    }
  }
  suspend() {
    this.active = false; this.needsSync = true;
    this.note = 'Entradas suspendidas. Al volver se consultará el estado.'; this.render();
  }

  mark(index) {
    const data = this.snapshot?.data;
    if (!this.active || !data || data.awaitingAI || data.result || data.board[index] !== '') return;
    return this.act('PLACE_MARK', { index });
  }
  retryAI() {
    if (this.active && this.snapshot?.data.awaitingAI) return this.act('RETRY_AI', {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const type of ['blur', 'focus', 'pagehide']) this.window.removeEventListener(type, this.handlers[type]);
    this.document.removeEventListener('visibilitychange', this.handlers.visibilitychange);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.view.dispose(); this.bridge.dispose();
  }
}

