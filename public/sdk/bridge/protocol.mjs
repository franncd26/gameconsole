export const PROTOCOL = 'gameconsole.bridge';
export const VERSION = 1;
export const MAX_BYTES = 65536;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v, keys, optional = []) => object(v) && keys.every((k) => Object.hasOwn(v, k))
  && Object.keys(v).every((k) => [...keys, ...optional].includes(k));
const text = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && !/\p{Cc}/u.test(v);
const messageId = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
export class BridgeError extends Error {
  constructor(code, unknown = false) { super('No se pudo completar la operación Bridge.'); this.code = code; this.unknown = unknown; }
}
export function copyJSON(value) {
  const parents = new Set();
  function visit(v, depth) {
    const fail = () => { throw new BridgeError('INVALID_MESSAGE'); };
    if (depth > 64) fail();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail(); return v; }
    if ((!object(v) && !Array.isArray(v)) || parents.has(v)) fail();
    parents.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
    if (keys.some((k) => typeof k !== 'string')) fail();
    if (Array.isArray(v) && (keys.length !== v.length + 1 || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(descriptors, i)).every(Boolean))) fail();
    const entries = keys.filter((k) => !(Array.isArray(v) && k === 'length')).map((k) => {
      const d = descriptors[k]; if (!d.enumerable || !Object.hasOwn(d, 'value')) fail();
      return [k, visit(d.value, depth + 1)];
    });
    parents.delete(v);
    return Array.isArray(v) ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  }
  return visit(value, 0);
}
export function fingerprint(v) {
  return v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
    ? `[${v.map(fingerprint).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${fingerprint(v[k])}`).join(',')}}`;
}
export function randomId(crypto = globalThis.crypto) {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function validateAction(action) {
  if (!exact(action, ['type', 'payload']) || typeof action.type !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(action.type)
    || !object(action.payload) || new TextEncoder().encode(JSON.stringify(action)).length > 8192) throw new BridgeError('INVALID_MESSAGE');
}
export function validateSnapshot(input) {
  const s = copyJSON(input);
  if (!exact(s, ['matchId', 'gameId', 'gameVersion', 'state', 'version', 'players', 'options', 'startData', 'data'], ['delivery'])
    || !text(s.matchId, 128) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.gameId) || !text(s.gameId, 64)
    || !text(s.gameVersion, 32) || !['running', 'closing', 'finished'].includes(s.state)
    || !Number.isSafeInteger(s.version) || s.version < 0 || !Array.isArray(s.players)
    || !object(s.options) || !object(s.startData) || !object(s.data)) throw new BridgeError('INVALID_MESSAGE');
  return s;
}
export function validateResult(input) {
  const r = copyJSON(input);
  if (!exact(r, ['outcome', 'committed', 'confirmations', 'snapshot'], ['error'])
    || !['completed', 'rejected', 'dependency_failed'].includes(r.outcome) || typeof r.committed !== 'boolean'
    || !Number.isSafeInteger(r.confirmations) || r.confirmations < 0
    || (r.error !== undefined && (!exact(r.error, ['code', 'message']) || !text(r.error.code, 64) || !text(r.error.message, 256)))) throw new BridgeError('INVALID_MESSAGE');
  if (r.snapshot !== null) validateSnapshot(r.snapshot);
  else if (r.outcome !== 'rejected' || r.committed || !r.error) throw new BridgeError('INVALID_MESSAGE');
  return r;
}
export function envelope(type, messageId, payload, channelId) {
  return validateMessage({ protocol: PROTOCOL, version: VERSION, type, messageId, payload, ...(channelId === undefined ? {} : { channelId }) });
}
export function validatePresentation(input) {
  const p = copyJSON(input);
  if (!exact(p, ['visible', 'canControl', 'autoPause', 'autoResume'])
    || Object.values(p).some(v => typeof v !== 'boolean')) throw new BridgeError('INVALID_MESSAGE');
  return p;
}
export function validateMessage(input, direction) {
  const m = copyJSON(input);
  if (!object(m)) throw new BridgeError('INVALID_MESSAGE');
  if (new TextEncoder().encode(JSON.stringify(m)).length > MAX_BYTES || !exact(m,
    ['protocol', 'version', 'type', 'messageId', 'payload', ...(m.type === 'READY' ? [] : ['channelId'])])
    || m.protocol !== PROTOCOL || m.version !== VERSION || !messageId(m.messageId)
    || (m.type !== 'READY' && (typeof m.channelId !== 'string' || !/^[a-f0-9]{32}$/.test(m.channelId)))) throw new BridgeError('INVALID_MESSAGE');
  const inbound = ['READY', 'ACTION_REQUEST', 'SNAPSHOT_REQUEST'], outbound = ['INIT', 'ACTION_RESULT', 'SNAPSHOT', 'ERROR', 'DETACH', 'PRESENTATION'];
  if (!(direction === 'game' ? inbound : direction === 'host' ? outbound : [...inbound, ...outbound]).includes(m.type)) throw new BridgeError('INVALID_MESSAGE');
  switch (m.type) {
    case 'PRESENTATION': validatePresentation(m.payload); break;
    case 'READY': case 'SNAPSHOT_REQUEST': if (!exact(m.payload, [])) throw new BridgeError('INVALID_MESSAGE'); break;
    case 'ACTION_REQUEST': if (!exact(m.payload, ['action'])) throw new BridgeError('INVALID_MESSAGE'); validateAction(m.payload.action); break;
    case 'INIT':
      if (!exact(m.payload, ['gameId', 'matchId', 'options', 'snapshot'])) throw new BridgeError('INVALID_MESSAGE');
      { const s = validateSnapshot(m.payload.snapshot);
        if (s.gameId !== m.payload.gameId || s.matchId !== m.payload.matchId || fingerprint(s.options) !== fingerprint(m.payload.options)) throw new BridgeError('INVALID_MESSAGE'); }
      break;
    case 'ACTION_RESULT': validateResult(m.payload); break;
    case 'SNAPSHOT': validateSnapshot(m.payload); break;
    case 'ERROR': if (!exact(m.payload, ['code', 'message'], ['unknown']) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(m.payload.code)
      || !text(m.payload.message, 256) || (m.payload.unknown !== undefined && typeof m.payload.unknown !== 'boolean')) throw new BridgeError('INVALID_MESSAGE'); break;
    case 'DETACH': if (!exact(m.payload, ['reason']) || !['disposed', 'reloaded', 'removed'].includes(m.payload.reason)) throw new BridgeError('INVALID_MESSAGE');
  }
  return m;
}
