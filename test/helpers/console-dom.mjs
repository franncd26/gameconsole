export class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, extra = {}) { for (const fn of this.listeners.get(type) || []) fn({ preventDefault() {}, ...extra }); }
}
export class Node extends Target {
  constructor(tag = 'div') {
    super(); this.tagName = tag; this.children = []; this.attributes = {}; this.classes = new Set(); this._text = '';
    this.classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) };
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
  }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parentNode = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(' '); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focusCount = (this.focusCount || 0) + 1; this.fire('focus'); }
  checkValidity() {
    if (this.type === 'checkbox') return true;
    if (this.required && !this.value.length) return false;
    if (this.type === 'number') return Number.isSafeInteger(Number(this.value)) && Number(this.value) >= this.min && Number(this.value) <= this.max;
    return !(this.minLength && this.value.length < this.minLength) && !(this.maxLength && this.value.length > this.maxLength);
  }
}
export class Document extends Target {
  constructor() { super(); this.hidden = false; this.nodes = new Map(); }
  createElement(tag) { return new Node(tag); }
  getElementById(id) { if (!this.nodes.has(id)) this.nodes.set(id, new Node()); return this.nodes.get(id); }
}
export class Window extends Target {
  constructor(search = '') { super(); this.location = { search, pathname: '/' }; this.history = { replaceState: (_state, _title, url) => { this.lastURL = url; } }; }
}
export class Bridge {
  constructor() { this.mounts = []; this.unmounts = []; this.refreshes = []; }
  mount(container, snapshot) { const frame = new Node('iframe'); frame.snapshot = structuredClone(snapshot); container.append(frame); this.mounts.push(frame); return frame; }
  unmount(frame) { this.unmounts.push(frame); frame.remove(); }
  async refresh(frame) { this.refreshes.push(frame); return true; }
  dispose() { this.disposed = true; }
}
export class Clock {
  constructor() { this.id = 0; this.jobs = new Map(); }
  setTimeout(fn, delay) { const id = ++this.id; this.jobs.set(id, { fn, delay }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  async next() { const value = this.jobs.entries().next().value; if (value) { this.jobs.delete(value[0]); value[1].fn(); } await settle(); }
  async runDelay(delay) { for (const [id, job] of [...this.jobs]) if (job.delay === delay) { this.jobs.delete(id); job.fn(); } await settle(); }
}
export async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export const plugin = (id = 'alpha', options = []) => ({ id, name: 'Nombre ' + id, description: 'Descripción del plugin', category: 'arcade', players: { min: 1, max: 1 }, capabilities: { multipleInstances: false }, options });
export const snapshot = (id = 'match-a', gameId = 'alpha', version = 0, state = 'running') => ({ gameId, matchId: id, gameVersion: '1.1.0', version, state, players: [{ id: 'human', role: 'human' }], options: {}, startData: {}, data: {}, delivery: { pending: 0, delivered: 1, status: 'delivered', error: null } });
export const dashboard = { source: 'GameStats / Scala', scope: 'current_process', consistency: 'per_match_snapshot', totals: { started: 77, active: 60, finished: 17, events: 901 }, games: [{ gameId: 'alpha', started: 77, active: 60, finished: 17, events: 901, metrics: [{ id: 'score', label: 'Puntos oficiales', value: 321, unit: 'points', invalidSamples: 2 }] }] };
