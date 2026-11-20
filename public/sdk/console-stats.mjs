// One observer/polling resource; no game rules, metric calculations or persistent cache.
export class PollResource {
  constructor({ task, interval, clock = globalThis, hidden = () => false, now = () => new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica', hour12: false }) }) {
    Object.assign(this, { task, interval, clock, hidden, now });
    this.listeners = new Set(); this.key = null; this.generation = 0; this.timer = null;
    this.inFlight = null; this.again = false; this.disposed = false;
    this.state = { status: 'idle', data: null, lastSuccess: null, error: null, key: null };
  }
  subscribe(fn) { this.listeners.add(fn); fn(structuredClone(this.state)); return () => this.listeners.delete(fn); }
  notify() { for (const fn of this.listeners) { try { fn(structuredClone(this.state)); } catch { /* Independent views. */ } } }
  setKey(key) {
    if (this.disposed) return;
    this.generation++; this.controller?.abort(); this.clearTimer(); this.key = key;
    this.state = { status: key === null ? 'idle' : 'pending', data: null, lastSuccess: null, error: null, key };
    this.again = Boolean(this.inFlight && key !== null); this.notify();
    return this.refresh();
  }
  clearTimer() { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
  refresh() {
    if (this.disposed || this.hidden() || this.key === null) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.clearTimer(); const generation = this.generation, key = this.key;
    const controller = new AbortController(); this.controller = controller;
    const valid = () => !this.disposed && generation === this.generation && !this.hidden();
    this.state.status = 'loading'; this.notify();
    // Defer task execution until inFlight is assigned, including synchronous mocks.
    this.inFlight = Promise.resolve().then(() => this.task(key, controller.signal)).then((response) => {
      if (!valid()) return;
      this.state.status = response.status === 202 ? 'pending' : 'updated';
      this.state.data = response.status === 202 ? null : structuredClone(response.data);
      this.state.error = null;
      if (response.status !== 202) this.state.lastSuccess = this.now();
      this.notify();
    }, (error) => {
      if (!valid()) return;
      this.state.status = 'failed'; this.state.error = { code: error?.code || 'UNAVAILABLE', status: error?.status || 0 };
      this.notify();
    }).finally(() => {
      this.inFlight = null;
      if (this.disposed || this.hidden() || this.key === null) return;
      if (this.again) { this.again = false; void this.refresh(); }
      else this.timer = this.clock.setTimeout(() => { this.timer = null; void this.refresh(); }, this.interval);
    });
    return this.inFlight;
  }
  visibilityChanged() {
    this.generation++; this.controller?.abort(); this.clearTimer();
    this.again = !this.hidden() && Boolean(this.inFlight);
    if (this.hidden()) { this.state.status = 'suspended'; this.notify(); }
    else void this.refresh();
  }
  dispose() { this.disposed = true; this.generation++; this.controller?.abort(); this.clearTimer(); this.listeners.clear(); }
}
