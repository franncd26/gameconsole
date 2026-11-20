import { BridgeError, copyJSON, envelope, fingerprint, randomId, validateMessage } from './protocol.mjs';

/** Browser-only facade. No SDK handles, HTTP routes, rules or analytics. */
export function createGameBridgeClient({ window = globalThis.window, hostOrigin = new URL(import.meta.url).origin, crypto = globalThis.crypto } = {}) {
  const parsed = new URL(hostOrigin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== hostOrigin || window.parent === window) throw new BridgeError('INVALID_HOST');
  const readyId = randomId(crypto), subscribers = Object.fromEntries(['init', 'snapshot', 'result', 'error', 'detach'].map((k) => [k, new Set()]));
  const pending = new Map();
  let channel, identity = null, snapshot = null, disposed = false;
  const notify = (type, value) => { for (const callback of subscribers[type]) { try { callback(copyJSON(value)); } catch { /* Independent UI observers. */ } } };
  const adopt = (s) => {
    if (s.gameId !== identity.gameId || s.matchId !== identity.matchId) throw new BridgeError('INVALID_MESSAGE');
    if (!snapshot || s.version >= snapshot.version) { snapshot = s; notify('snapshot', s); }
  };
  const rejectAll = () => { for (const request of pending.values()) request.reject(new BridgeError('BRIDGE_DETACHED', request.kind === 'ACTION_REQUEST')); pending.clear(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true; rejectAll(); window.removeEventListener('message', receive); window.removeEventListener('load', ready);
    for (const set of Object.values(subscribers)) set.clear(); channel = undefined; identity = null; snapshot = null;
  };
  const receive = (event) => {
    if (disposed || event.source !== window.parent || event.origin !== hostOrigin) return;
    let m;
    try { m = validateMessage(event.data, 'host'); } catch { return; }
    if (m.type === 'INIT') {
      if (m.messageId !== readyId || (channel && channel !== m.channelId)) return;
      channel = m.channelId; identity = { gameId: m.payload.gameId, matchId: m.payload.matchId, options: m.payload.options };
      adopt(m.payload.snapshot); notify('init', { ...identity, snapshot }); return;
    }
    if (!channel || m.channelId !== channel) return;
    if (m.type === 'DETACH') {
      rejectAll(); channel = undefined; identity = null; snapshot = null; notify('detach', m.payload);
      if (m.payload.reason !== 'reloaded') dispose();
      return;
    }
    const request = pending.get(m.messageId);
    if (m.type === 'SNAPSHOT') {
      try { adopt(m.payload); } catch { return; }
      if (request?.kind === 'SNAPSHOT_REQUEST') { pending.delete(m.messageId); request.resolve(copyJSON(snapshot)); }
    } else if (m.type === 'ACTION_RESULT' && request?.kind === 'ACTION_REQUEST') {
      if (m.payload.snapshot && (m.payload.snapshot.gameId !== identity.gameId || m.payload.snapshot.matchId !== identity.matchId)) return;
      pending.delete(m.messageId); notify('result', m.payload); request.resolve(copyJSON(m.payload));
    } else if (m.type === 'ERROR') {
      notify('error', { ...m.payload, messageId: m.messageId });
      if (request) { pending.delete(m.messageId); request.reject(new BridgeError(m.payload.code, m.payload.unknown)); }
    }
  };
  window.addEventListener('message', receive);
  const ready = () => { if (!disposed) window.parent.postMessage(envelope('READY', readyId, {}), hostOrigin); };
  const send = (kind, payload, messageId = randomId(crypto)) => {
    if (disposed || !channel) return Promise.reject(new BridgeError('BRIDGE_NOT_READY'));
    let message;
    try { message = envelope(kind, messageId, payload, channel); } catch { return Promise.reject(new BridgeError('INVALID_MESSAGE')); }
    const signature = fingerprint({ kind, payload: message.payload }), old = pending.get(messageId);
    if (old) return old.signature === signature ? old.promise : Promise.reject(new BridgeError('MESSAGE_CONFLICT'));
    if (pending.size >= 4) return Promise.reject(new BridgeError('BRIDGE_BUSY'));
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    pending.set(messageId, { kind, signature, promise, resolve, reject });
    try { window.parent.postMessage(message, hostOrigin); }
    catch { pending.delete(messageId); reject(new BridgeError('RESULT_UNKNOWN', kind === 'ACTION_REQUEST')); }
    return promise;
  };
  const subscribe = (type, callback) => {
    if (disposed || typeof callback !== 'function') throw new BridgeError('INVALID_OBSERVER');
    subscribers[type].add(callback);
    if (type === 'snapshot' && snapshot) { try { callback(copyJSON(snapshot)); } catch {} }
    if (type === 'init' && identity) { try { callback(copyJSON({ ...identity, snapshot })); } catch {} }
    return () => subscribers[type].delete(callback);
  };
  ready();
  window.addEventListener('load', ready); // READY before and after load tolerates iframe/module event ordering.
  return Object.freeze({
    ready,
    getIdentity: () => identity ? copyJSON(identity) : null,
    getSnapshot: () => snapshot ? copyJSON(snapshot) : null,
    onInit: (fn) => subscribe('init', fn), onSnapshot: (fn) => subscribe('snapshot', fn),
    onResult: (fn) => subscribe('result', fn), onError: (fn) => subscribe('error', fn), onDetach: (fn) => subscribe('detach', fn),
    dispatch: (type, payload, { messageId } = {}) => send('ACTION_REQUEST', { action: { type, payload } }, messageId),
    requestSnapshot: ({ messageId } = {}) => send('SNAPSHOT_REQUEST', {}, messageId),
    dispose,
  });
}
