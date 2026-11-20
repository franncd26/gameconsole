export class FakeWindow {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, value = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(value); }
}
export function windows(host = new FakeWindow()) {
  const game = new FakeWindow(), outbound = [], inbound = [];
  const parent = { postMessage(data, origin) {
    outbound.push({ data: structuredClone(data), origin });
    queueMicrotask(() => host.emit('message', { data, source: child, origin: 'null' }));
  } };
  const child = { postMessage(data, origin) {
    inbound.push({ data: structuredClone(data), origin });
    queueMicrotask(() => game.emit('message', { data, source: parent, origin: 'http://console.test' }));
  } };
  game.parent = parent;
  const frame = new FakeWindow();
  frame.contentWindow = child; frame.isConnected = true; frame.getAttribute = () => 'allow-scripts';
  frame.remove = () => { frame.isConnected = false; };
  return { host, game, parent, child, frame, inbound, outbound };
}
export function snapshot(gameId = 'alpha', matchId = 'match-a', version = 0) {
  return { gameId, matchId, gameVersion: '1.1.0', state: 'running', version,
    players: [{ id: 'human', role: 'human' }], options: {}, startData: {}, data: { count: version } };
}
export const result = (s, extra = {}) => ({ outcome: 'completed', committed: true, confirmations: 1, snapshot: structuredClone(s), ...extra });
export const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
export const settle = () => new Promise((resolve) => setImmediate(resolve));
export function gate() { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; }
