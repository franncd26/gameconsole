// Local UX coordination, never authentication or an SDK lifecycle transition.
export const preferenceDefaults = Object.freeze({ pauseWhenHidden: true, resumeWhenVisible: true });
const key = 'gameconsole.presentation.v1';
export function readPreferences(storage) {
  try {
    const p = JSON.parse(storage?.getItem(key));
    if (p && Object.keys(p).length === 2 && Object.keys(preferenceDefaults).every(k => typeof p[k] === 'boolean')) return p;
  } catch { /* Storage may be denied. */ }
  return { ...preferenceDefaults };
}
export function savePreferences(storage, preferences) {
  try { storage?.setItem(key, JSON.stringify(preferences)); return Boolean(storage); } catch { return false; }
}

export class PresentationCoordinator {
  constructor({ bridge, locks, channel, onChange = () => {}, onError = () => {} }) {
    Object.assign(this, { bridge, locks, channel, onChange, onError });
    this.records = new Map(); this.disposed = false;
    this.receive = event => {
      const m = event.data;
      if (!m || m.type !== 'REQUEST_CONTROL' || typeof m.matchId !== 'string' || Object.keys(m).length !== 2) return;
      const r = this.records.get(m.matchId);
      if (r?.owner) void this.yield(r);
    };
    channel?.addEventListener('message', this.receive);
  }
  sync(records, { section, mode, selectedId, hidden, preferences }) {
    if (this.disposed) return;
    for (const [id, r] of this.records) if (!records.get(id)?.frame || records.get(id).snapshot.state !== 'running' || records.get(id).frame !== r.frame) this.remove(id);
    for (const [id, view] of records) {
      if (!view.frame || view.snapshot.state !== 'running') continue;
      let r = this.records.get(id);
      if (!r) {
        r = { id, frame: view.frame, owner: !this.locks, pending: false, removed: false };
        this.records.set(id, r);
      }
      r.presentation = { visible: !hidden && section === 'play' && (mode === 'grid' || selectedId === id),
        canControl: r.owner && !r.yielding, autoPause: preferences.pauseWhenHidden, autoResume: preferences.resumeWhenVisible };
      this.publish(r);
      if (!r.attempted) { r.attempted = true; void this.acquire(r, false); }
    }
  }
  publish(r) {
    if (r.removed || !r.presentation) return;
    r.presentation.canControl = r.owner && !r.yielding;
    this.bridge.setPresentation?.(r.frame, r.presentation);
    this.onChange(r.id, { canControl: r.presentation.canControl, supported: Boolean(this.locks), pending: r.pending });
  }
  async acquire(r, wait) {
    if (r.removed || r.pending || r.owner || !this.locks) return;
    r.pending = true; r.abort = new AbortController(); this.publish(r);
    try {
      await this.locks.request('gameconsole:match:' + r.id, wait ? { signal: r.abort.signal } : { ifAvailable: true }, async lock => {
        if (!lock || r.removed) return;
        r.owner = true; r.pending = false;
        const held = new Promise(resolve => { r.release = resolve; });
        this.publish(r); // The plugin must resync before its next action.
        await held;
        r.owner = false;
      });
    } catch (error) { if (!r.removed && error?.name !== 'AbortError') this.onError('No se pudo coordinar el control entre pestañas.'); }
    finally { r.pending = false; this.publish(r); }
  }
  take(id) {
    const r = this.records.get(id);
    if (!r || r.owner || !this.locks) return;
    if (r.pending) { r.abort?.abort(); return; }
    // Queue first; BroadcastChannel asks the owner to drain. The lock, not the message, grants ownership.
    void this.acquire(r, true);
    this.channel?.postMessage({ type: 'REQUEST_CONTROL', matchId: id });
  }
  async yield(r) {
    if (r.removed || r.yielding) return;
    r.yielding = true; this.publish(r);
    try {
      await this.bridge.waitForIdle?.(r.frame);
      if (r.removed) return;
      r.owner = false; r.release?.(); r.release = null;
    } catch {
      // An unknown action may still be executing on the server. Never transfer automatically.
      this.onError('Hay una acción de resultado desconocido. Resuélvela antes de transferir el control.');
    } finally { r.yielding = false; this.publish(r); }
  }
  remove(id) {
    const r = this.records.get(id); if (!r) return;
    r.yielding = true; this.publish(r);
    r.removed = true; r.abort?.abort(); this.records.delete(id);
    // An ordinary unmount drains its already-started transport before freeing ownership.
    // Closing/crashing a browser document cannot guarantee an asynchronous drain.
    Promise.resolve().then(() => this.bridge.waitForIdle?.(r.frame)).catch(() => {
      if (!this.disposed) this.onError('La vista se cerró con una operación de resultado desconocido. Consulta el estado antes de continuar.');
    }).finally(() => { r.release?.(); r.release = null; });
  }
  dispose() {
    this.disposed = true;
    for (const id of this.records.keys()) this.remove(id);
    this.channel?.removeEventListener('message', this.receive); this.channel?.close();
  }
}
