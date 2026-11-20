// Presentation controller only: snapshots and rules belong to the server.
export class RacingController {
  constructor({ bridge, view, window, document, clock = globalThis, id = () => globalThis.crypto.randomUUID() }) {
    Object.assign(this, { bridge, view, window, document, clock, id });
    this.snapshot = null; this.identity = null; this.connected = false;
    this.busy = false; this.disposed = false; this.uncertain = null; this.needsSync = true;
    this.syncing = false;
    this.syncFailed = false;
    this.active = !document.hidden; this.armed = false; this.timer = null;
    this.started = false; this.manuallyPaused = false; this.resumePending = false; this.presentationRevision = 0;
    this.presentation = { visible: !document.hidden, canControl: true, autoPause: true, autoResume: true };
    this.note = 'Esperando conexión con GameConsole…';
    this.lane = null; this.accelerate = false; this.brake = false;
    this.unsubscribers = [
      bridge.onInit((value) => {
        if (this.disposed) return;
        this.identity = value; this.connected = true; this.needsSync = false; this.note = 'Conectado';
        this.adopt(value.snapshot); this.render();
      }),
      bridge.onSnapshot((snapshot) => this.adopt(snapshot)),
      bridge.onResult((result) => { this.lastOutcome = result.outcome; }),
      bridge.onError((error) => this.report(error)),
      bridge.onDetach(() => { this.connected = false; this.armed = false; this.clearTimer(); this.note = 'Desconectado. Remonta el iframe desde la consola.'; this.render(); this.dispose(); }),
    ];
    this.handlers = {
      keydown: (event) => this.key(event, true), keyup: (event) => this.key(event, false),
      blur: () => { this.clearInputs(); this.render(); },
      focus: () => this.render(),
      visibilitychange: () => { if (!this.hostPresentation) this.present({ ...this.presentation, visible: !document.hidden }); },
      pagehide: () => this.dispose(),
    };
    for (const type of ['keydown', 'keyup', 'blur', 'focus', 'pagehide']) window.addEventListener(type, this.handlers[type]);
    document.addEventListener('visibilitychange', this.handlers.visibilitychange);
    view.bind({
      lane: (delta) => this.changeLane(delta),
      pedal: (name, pressed) => { this[name] = pressed; this.render(); },
      start: () => void this.start(), sync: () => void this.sync(),
      replay: () => { if (this.uncertain) void this.act(this.uncertain.type, this.uncertain.payload, this.uncertain); },
    });
    if (bridge.onPresentation) this.unsubscribers.push(bridge.onPresentation(p => { this.hostPresentation = true; this.present(p); }));
    this.render();
  }
  adopt(snapshot) {
    if (this.disposed || !snapshot) return;
    if (this.identity && (snapshot.matchId !== this.identity.matchId || snapshot.gameId !== this.identity.gameId)) return;
    if (this.snapshot && (snapshot.matchId !== this.snapshot.matchId || snapshot.version < this.snapshot.version)) return;
    this.snapshot = structuredClone(snapshot);
    if (snapshot.state !== 'running') { this.armed = false; this.resumePending = false; this.clearInputs(); this.clearTimer(); }
    this.render();
  }
  render() {
    if (!this.disposed) this.view.render({
      snapshot: this.snapshot ? structuredClone(this.snapshot) : null,
      connected: this.connected, busy: this.busy, syncing: this.syncing, syncFailed: this.syncFailed, uncertain: Boolean(this.uncertain), needsSync: this.needsSync,
      note: this.note, armed: this.armed, active: this.active, presentationState: this.presentationState, canControl: this.presentation.canControl,
      accelerate: this.accelerate, brake: this.brake,
    });
  }
  report(error) {
    if (this.disposed) return;
    this.syncFailed = true;
    this.armed = false; this.needsSync = true; this.clearTimer();
    const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'BRIDGE_ERROR';
    this.note = code === 'RESULT_UNKNOWN' || error?.unknown
      ? 'Resultado desconocido. Consulta el estado o recupera la misma operación; no se reintentará automáticamente.'
      : 'No se pudo completar la solicitud (' + code + '). Consulta el estado.';
    if (['BRIDGE_DETACHED', 'BRIDGE_NOT_READY', 'BRIDGE_MESSAGE_TOO_LARGE', 'MESSAGE_TOO_LARGE'].includes(code)) this.connected = false;
    this.render();
  }
  async sync() {
    if (this.disposed || !this.connected || this.busy) return;
    this.busy = true; this.syncing = true; this.clearTimer(); this.render();
    try { this.adopt(await this.bridge.requestSnapshot()); this.adopt(this.bridge.getSnapshot()); this.needsSync = false; this.syncFailed = false; return true; }
    catch (error) { this.report(error); return false; }
    finally {
      this.busy = false; this.syncing = false; this.render();
      if (this.resumePending && !this.disposed && !this.uncertain) {
        this.resumePending = false; queueMicrotask(() => { void this.resume(); });
      } else this.schedule();
    }
  }
  async act(type, payload, replay = null) {
    if (this.disposed || this.busy || !this.connected || !this.active || !this.presentation.canControl || this.snapshot?.state !== 'running' || ((this.uncertain || this.needsSync) && !replay)) return;
    const operation = replay || { type, payload: structuredClone(payload), messageId: this.id() };
    this.busy = true; this.needsSync = true; this.clearTimer(); this.note = this.armed ? 'Jugando' : 'Procesando…'; this.render();
    let known = false;
    try {
      const result = await this.bridge.dispatch(operation.type, operation.payload, { messageId: operation.messageId });
      known = true; this.uncertain = null;
      if (this.disposed) return result;
      // ACTION_RESULT can be a replay of an older version. Never render its snapshot.
      this.note = result.outcome === 'completed' ? (this.armed ? 'Jugando' : 'Acción confirmada')
        : result.outcome === 'dependency_failed' ? (result.committed ? 'Cambio confirmado; falló una dependencia. Consulta el estado para continuar.' : 'La dependencia falló; no hubo nuevos cambios.')
        : 'Acción rechazada (' + (result.error?.code || 'REJECTED') + ').';
      if (result.outcome !== 'completed') { this.armed = false; this.clearTimer(); }
      this.adopt(await this.bridge.requestSnapshot()); this.adopt(this.bridge.getSnapshot()); this.needsSync = false;
      return result;
    } catch (error) {
      if (!known && (error?.unknown || error?.code === 'RESULT_UNKNOWN')) this.uncertain = operation;
      this.report(error);
    } finally {
      this.busy = false; this.render();
      if (!this.disposed) { if (this.resumePending && !this.uncertain) void this.resume(); else this.schedule(); }
    }
  }
  clearTimer() { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
  get presentationState() {
    if (this.snapshot && this.snapshot.state !== 'running') return 'finished';
    if (this.uncertain) return 'uncertain';
    if (!this.presentation.canControl) return 'spectator';
    if (this.manuallyPaused) return 'manuallyPaused';
    if (!this.active) return 'autoSuspended';
    if (this.armed && !this.syncing) return 'playing';
    if (this.busy || this.needsSync && this.started) return 'resyncing';
    return this.armed ? 'playing' : 'ready';
  }
  clearInputs() { this.lane = null; this.accelerate = false; this.brake = false; }
  present(p) {
    if (this.disposed) return;
    const before = this.active;
    if ((!p.visible && this.presentation.visible) || !p.canControl) this.clearInputs();
    this.presentation = structuredClone(p);
    this.active = p.canControl && (!p.autoPause || p.visible);
    if (before !== this.active) {
      this.presentationRevision++; this.clearInputs(); this.clearTimer(); this.needsSync = true; this.armed = false;
      this.resumePending = this.active && this.started && !this.manuallyPaused && p.autoResume && !this.uncertain;
      if (this.resumePending && !this.busy) void this.resume();
    }
    this.render();
  }
  suspend() { this.present({ ...this.presentation, visible: false }); }
  async start() {
    if (this.armed) {
      this.manuallyPaused = true; this.armed = false; this.resumePending = false;
      this.clearTimer(); this.clearInputs(); this.render(); return;
    }
    if (this.disposed || !this.connected || this.busy || this.uncertain || !this.active) return;
    this.started = true; this.manuallyPaused = false;
    return this.resume();
  }
  async resume() {
    if (this.disposed || this.busy || this.uncertain || !this.active || this.manuallyPaused || !this.connected) return;
    this.resumePending = false;
    const revision = this.presentationRevision;
    if (!await this.sync()) return;
    if (this.disposed || !this.active || !this.connected || this.snapshot?.state !== 'running' || this.uncertain || this.manuallyPaused) return;
    if (revision !== this.presentationRevision) { if (this.resumePending) return this.resume(); return; }
    this.armed = true; this.note = 'Jugando'; this.schedule(); this.render();
  }
  schedule() {
    this.clearTimer();
    if (!this.disposed && this.armed && this.active && this.connected && !this.busy && !this.needsSync && !this.uncertain && this.snapshot?.state === 'running') {
      this.timer = this.clock.setTimeout(() => { this.timer = null; void this.tick(); }, 180);
    }
  }


  changeLane(delta) {
    if (!this.active || !this.snapshot) return;
    this.lane = Math.max(0, Math.min(2, (this.lane ?? this.snapshot.data.lane) + delta));
  }
  key(event, down) {
    const key = event.key.toLowerCase();
    if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'].includes(key)) return;
    event.preventDefault();
    if (!this.active) return;
    if (down && !event.repeat && ['arrowleft', 'a'].includes(key)) this.changeLane(-1);
    if (down && !event.repeat && ['arrowright', 'd'].includes(key)) this.changeLane(1);
    if (['arrowup', 'w'].includes(key)) this.accelerate = down;
    if (['arrowdown', 's'].includes(key)) this.brake = down;
    this.render();
  }
  tick() { return this.act('STEP', { lane: this.lane ?? this.snapshot.data.lane, accelerate: this.accelerate, brake: this.brake }); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.clearTimer(); this.armed = false;
    for (const type of ['keydown', 'keyup', 'blur', 'focus', 'pagehide']) this.window.removeEventListener(type, this.handlers[type]);
    this.document.removeEventListener('visibilitychange', this.handlers.visibilitychange);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.view.dispose(); this.bridge.dispose();
  }
}

