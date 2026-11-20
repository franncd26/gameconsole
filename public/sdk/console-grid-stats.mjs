import { ConsoleError } from './console-api.mjs';

// One bounded query pool for grid summaries AND the existing selected-match poller.
// It caches service responses, never domain state or calculated metrics.
export class GridResultsCoordinator {
  constructor({ api, onUpdate, clock = globalThis, now = () => Date.now(), interval = 5000, concurrency = 2, cacheLimit = 64 }) {
    Object.assign(this, { api, onUpdate, clock, now, interval, concurrency, cacheLimit });
    this.views = new Map(); this.cache = new Map(); this.jobs = new Map(); this.queue = [];
    this.active = 0; this.timer = null; this.disposed = false;
  }
  setViews(views, selectedId, { hidden = false } = {}) {
    if (this.disposed) return;
    this.paused = hidden;
    this.selectedId = selectedId;
    for (const [id, view] of this.views) if (views.get(id)?.frame !== view.frame || views.get(id)?.gameId !== view.gameId) this.views.delete(id);
    for (const [id, input] of views) if (!this.views.has(id)) {
      if (this.cache.get(id)?.state.data && this.cache.get(id).state.data.gameId !== input.gameId) this.cache.delete(id);
      const view = { ...input }; this.views.set(id, view);
      this.notify(id, view, this.cache.get(id)?.state || { status: 'pending', data: null });
    }
    // Queued background reads with no remaining consumer must never start.
    for (const job of [...this.queue]) if (hidden || !job.main && this.views.get(job.id) !== job.view) this.cancel(job);
    this.poll();
    this.drain();
  }
  notify(id, view, state) {
    if (this.disposed || this.views.get(id) !== view || !view) return;
    if (state.data && (state.data.matchId !== id || state.data.gameId !== view.gameId)) return;
    try { this.onUpdate(id, view.frame, structuredClone(state)); } catch { /* A view cannot stall the shared query pool. */ }
  }
  selected(state) {
    const view = this.views.get(state.key);
    if (view) this.notify(state.key, view, state);
  }
  poll() {
    if (this.disposed) return;
    this.clearTimer();
    for (const [id, view] of this.views) if (id !== this.selectedId && !this.jobs.has(id)
      && (!this.cache.has(id) || this.now() - this.cache.get(id).at >= this.interval)) {
      void this.request(id, view.gameId, false).catch(() => {});
    }
    this.arm();
  }
  arm() {
    this.clearTimer();
    if (this.disposed || this.paused) return;
    let delay = Infinity;
    for (const id of this.views.keys()) if (id !== this.selectedId && !this.jobs.has(id)) {
      delay = Math.min(delay, this.cache.has(id) ? this.cache.get(id).at + this.interval - this.now() : 0);
    }
    if (Number.isFinite(delay)) this.timer = this.clock.setTimeout(() => { this.timer = null; this.poll(); }, Math.max(1, delay));
  }
  fetch(id, gameId) { return this.request(id, gameId, true); }
  request(id, gameId, main) {
    if (this.disposed || this.paused) return Promise.reject(new ConsoleError(0));
    const old = this.jobs.get(id);
    if (old) {
      if (gameId && old.gameId && gameId !== old.gameId) return Promise.reject(new ConsoleError(502, 'INVALID_RESPONSE'));
      if (main) { old.main = true; if (!old.started) { this.queue = this.queue.filter(job => job !== old); this.queue.unshift(old); } }
      return old.promise.then(structuredClone);
    }
    const cached = this.cache.get(id);
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const job = { id, gameId, main, view: this.views.get(id), resolve, reject, promise, controller: new AbortController() };
    this.jobs.set(id, job); if (main) this.queue.unshift(job); else this.queue.push(job);
    this.notify(id, job.view, { ...cached?.state, status: 'loading' });
    this.drain(); return promise.then(structuredClone);
  }
  drain() {
    while (!this.disposed && !this.paused && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); job.started = true; this.active++;
      void this.execute(job);
    }
  }
  async execute(job) {
    const previous = this.cache.get(job.id)?.state;
    try {
      const response = await this.api.results(job.id, job.controller.signal);
      if (![200, 202].includes(response.status) || (response.status === 200 && (response.data.matchId !== job.id
        || job.gameId && response.data.gameId !== job.gameId))) throw new ConsoleError(502, 'INVALID_RESPONSE');
      if (this.disposed) throw new ConsoleError(0);
      const state = { status: response.status === 202 ? 'pending' : 'updated', data: response.status === 202 ? null : response.data,
        lastSuccess: response.status === 200 ? new Date(this.now()).toLocaleString('es-CR', { timeZone: 'America/Costa_Rica', hour12: false }) : previous?.lastSuccess, error: null };
      // A removed/replaced background view does not populate a replacement's cache.
      const current = this.views.get(job.id);
      if ((!current || current.gameId === response.data.gameId || response.status === 202) && (job.main || current === job.view)) this.remember(job.id, { response: structuredClone(response), state, at: this.now() });
      this.notify(job.id, job.view, state); job.resolve(response);
    } catch (error) {
      const safe = new ConsoleError(error?.status || 0, error?.code);
      const state = { ...previous, status: 'failed', error: { status: safe.status, code: safe.code } };
      if (!this.disposed && (job.main || this.views.get(job.id) === job.view)) this.remember(job.id, { state, at: this.now() });
      this.notify(job.id, job.view, state); job.reject(safe);
    } finally {
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
      this.active--; this.drain(); this.arm();
    }
  }
  remember(id, value) {
    this.cache.delete(id); this.cache.set(id, structuredClone(value));
    while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
  }
  cancel(job) {
    this.queue = this.queue.filter(item => item !== job); this.jobs.delete(job.id);
    job.controller.abort(); job.reject(new ConsoleError(0));
  }
  clearTimer() { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
  dispose() {
    this.disposed = true; this.clearTimer(); this.views.clear(); this.cache.clear();
    for (const job of [...this.queue]) this.cancel(job);
    for (const job of this.jobs.values()) job.controller.abort();
  }
}
