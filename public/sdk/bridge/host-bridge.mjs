import { BridgeError, copyJSON, envelope, fingerprint, randomId, validateMessage, validateResult, validateSnapshot, validatePresentation } from './protocol.mjs';

/** One association per iframe. The SDK remains the sole execution queue and state authority. */
export class HostBridge {
  #window; #fetch; #crypto; #records = new Map(); #usedFrames = new WeakSet(); #drains = new WeakMap(); #listener; #observer; #status; #navigate;
  constructor({ window = globalThis.window, fetcher = (...args) => globalThis.fetch(...args), crypto = globalThis.crypto, onStatus = () => {}, onNavigate = () => {} } = {}) {
    this.#window = window; this.#fetch = fetcher; this.#crypto = crypto; this.#status = onStatus;
    this.#navigate = onNavigate;
    this.#listener = (event) => { void this.#receive(event); };
    window.addEventListener('message', this.#listener);
    if (window.MutationObserver && window.document?.documentElement) {
      this.#observer = new window.MutationObserver(() => {
        for (const frame of this.#records.keys()) if (!frame.isConnected) this.detach(frame, 'removed');
      });
      this.#observer.observe(window.document.documentElement, { childList: true, subtree: true });
    }
  }
  #notify(r, state, code) {
    try { this.#status({ state, gameId: r.gameId, matchId: r.matchId, ...(code ? { code } : {}) }); } catch { /* UI observer cannot affect transport. */ }
  }
  mount(container, snapshot) {
    const frame = this.#window.document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = 'Plugin GameConsole'; frame.width = '600'; frame.height = '360';
    this.attach(frame, snapshot);
    frame.src = `/sdk/web/${encodeURIComponent(snapshot.gameId)}/`;
    container.append(frame);
    return frame;
  }
  attach(frame, input, { loaded = false } = {}) {
    const snapshot = validateSnapshot(input);
    if (frame.getAttribute('sandbox') !== 'allow-scripts' || this.#usedFrames.has(frame) || this.#records.size >= 32) throw new BridgeError('INVALID_FRAME');
    const r = { frame, gameId: snapshot.gameId, matchId: snapshot.matchId, snapshot, loaded,
      generation: 0, channel: null, ready: null, requests: new Map(), unresolved: new Set(), busy: false, needsSync: false };
    r.load = () => {
      if (r.loaded) {
        // WindowProxy survives navigation; it does not identify the new document.
        // Never reconnect that element automatically, or send its replacement an old channel.
        this.detach(frame, 'reloaded'); this.#notify(r, 'error', 'NAVIGATION_REQUIRES_REMOUNT');
      } else r.loaded = true; // Pre-load READY is discarded; the client announces again on load.
    };
    frame.addEventListener('load', r.load); this.#usedFrames.add(frame); this.#records.set(frame, r); this.#notify(r, 'attached');
    return frame;
  }
  #active(r, generation) { return this.#records.get(r.frame) === r && r.frame.isConnected && r.generation === generation; }
  #send(r, type, id, payload) {
    if (!this.#active(r, r.generation) || !r.channel) return false;
    try { r.frame.contentWindow.postMessage(envelope(type, id, payload, r.channel), '*'); return true; }
    catch {
      this.#notify(r, 'error', 'BRIDGE_MESSAGE_TOO_LARGE');
      if (type !== 'ERROR' && type !== 'INIT') {
        try { r.frame.contentWindow.postMessage(envelope('ERROR', id, { code: 'BRIDGE_MESSAGE_TOO_LARGE',
          message: 'El mensaje excede el contrato Bridge.', unknown: r.requests.has(id) }, r.channel), '*'); } catch { /* Detached or unavailable window. */ }
      }
      return false;
    }
  }
  #error(r, id, code, unknown = false) {
    this.#send(r, 'ERROR', id, { code, message: 'No se pudo completar la solicitud Bridge.', unknown });
    this.#notify(r, 'error', code);
  }
  #invalidate(r, reason) {
    if (r.channel && reason !== 'reloaded') this.#send(r, 'DETACH', randomId(this.#crypto), { reason });
    r.generation++; r.channel = null; r.ready = null; r.requests.clear(); r.busy = false; r.needsSync = false; r.reading = false;
  }
  detach(frame, reason = 'disposed') {
    const r = this.#records.get(frame); if (!r) return;
    const drain = Promise.allSettled([...r.requests.values()].map(request => request.pending).filter(Boolean));
    this.#drains.set(frame, drain);
    this.#invalidate(r, reason); this.#records.delete(frame); frame.removeEventListener('load', r.load); this.#notify(r, 'detached');
  }
  unmount(frame) { this.detach(frame); frame.remove(); }
  /** Presentation only. Setting false immediately gates new actions; an accepted action is never cancelled. */
  setPresentation(frame, input) {
    const p = validatePresentation(input), r = this.#records.get(frame);
    if (!r) return false;
    r.presentation = p;
    return this.#send(r, 'PRESENTATION', randomId(this.#crypto), p);
  }
  async waitForIdle(frame) {
    const r = this.#records.get(frame);
    if (!r) { await this.#drains.get(frame); return; }
    // Includes the snapshot read after dispatch. No separate execution queue.
    await Promise.allSettled([...r.requests.values()].map(request => request.pending).filter(Boolean));
    if (r.unresolved.size) throw new BridgeError('RESULT_UNKNOWN', true);
  }
  /** Host-only refresh after an administrative change; no reload or new channel. */
  async refresh(frame) {
    const r = this.#records.get(frame);
    if (!r?.channel || !this.#active(r, r.generation)) throw new BridgeError('BRIDGE_NOT_READY');
    if (r.reading) return false;
    const generation = r.generation;
    r.reading = true;
    try { return await this.#refresh(r, randomId(this.#crypto), generation); }
    finally { if (this.#active(r, generation)) r.reading = false; }
  }
  dispose() {
    for (const frame of this.#records.keys()) this.detach(frame);
    this.#observer?.disconnect(); this.#window.removeEventListener('message', this.#listener);
  }
  async #read(r) {
    const response = await this.#fetch(`/api/sdk/matches/${encodeURIComponent(r.matchId)}`, { cache: 'no-store' });
    if (!response.ok) throw new BridgeError('SNAPSHOT_UNAVAILABLE');
    const s = validateSnapshot(await response.json());
    if (s.matchId !== r.matchId || s.gameId !== r.gameId) throw new BridgeError('INVALID_HTTP_RESULT');
    return s;
  }
  #adopt(r, s) { if (s.version >= r.snapshot.version) r.snapshot = s; }
  async #refresh(r, id, generation) {
    try {
      const s = await this.#read(r);
      if (!this.#active(r, generation)) return;
      this.#adopt(r, s); r.needsSync = false; return this.#send(r, 'SNAPSHOT', id, r.snapshot);
    } catch { if (this.#active(r, generation)) { r.needsSync = true; this.#error(r, id, 'SNAPSHOT_UNAVAILABLE'); } return false; }
  }
  async #ready(r, m) {
    // No READY replay/resend and no cross-load mailbox. A live channel never reissues INIT.
    if (!r.loaded || r.ready !== null || r.channel) return;
    r.ready = m.messageId;
    const generation = r.generation;
    try {
      const s = await this.#read(r);
      if (!this.#active(r, generation)) return;
      this.#adopt(r, s); r.channel = randomId(this.#crypto);
      if (this.#send(r, 'INIT', m.messageId, { gameId: r.gameId, matchId: r.matchId, options: r.snapshot.options, snapshot: r.snapshot })) {
        if (r.presentation) this.#send(r, 'PRESENTATION', randomId(this.#crypto), r.presentation);
        this.#notify(r, 'initialized');
      }
      else { r.channel = null; r.ready = null; }
    } catch { if (this.#active(r, generation)) { r.ready = null; this.#notify(r, 'error', 'SNAPSHOT_UNAVAILABLE'); } }
  }
  async #receive(event) {
    const r = [...this.#records.values()].find((item) => item.frame.contentWindow === event.source && event.source);
    if (!r) return;
    if (!r.frame.isConnected) { this.detach(r.frame, 'removed'); return; }
    if (event.origin !== 'null') { this.#notify(r, 'error', 'INVALID_SOURCE'); return; }
    let m;
    try { m = validateMessage(event.data, 'game'); }
    catch { this.#notify(r, 'error', 'INVALID_MESSAGE'); return; }
    if (m.type === 'READY') { await this.#ready(r, m); return; }
    if (!r.channel || r.channel !== m.channelId) { this.#notify(r, 'error', 'INVALID_CHANNEL'); return; }
    const generation = r.generation;
    if (m.type === 'NAVIGATION_REQUEST') {
      r.navigationIds ||= new Set();
      if (r.navigationIds.has(m.messageId)) return;
      r.navigationIds.add(m.messageId);
      if (r.navigationIds.size > 32) r.navigationIds.delete(r.navigationIds.values().next().value);
      try { this.#navigate({ matchId: r.matchId, direction: m.payload.direction }); } catch { /* Independent host UI. */ }
      return;
    }
    if (m.type === 'SNAPSHOT_REQUEST') {
      if (r.requests.has(m.messageId)) return this.#error(r, m.messageId, 'MESSAGE_CONFLICT');
      if (r.reading) return this.#error(r, m.messageId, 'BRIDGE_BUSY');
      r.reading = true;
      try { await this.#refresh(r, m.messageId, generation); } finally { if (this.#active(r, generation)) r.reading = false; }
      return;
    }
    if (r.presentation && !r.presentation.canControl) return this.#error(r, m.messageId, 'SPECTATOR');
    const signature = fingerprint(m.payload.action);
    let record = r.requests.get(m.messageId);
    if (record && record.signature !== signature) return this.#error(r, m.messageId, 'MESSAGE_CONFLICT');
    if (record?.result) {
      this.#send(r, 'ACTION_RESULT', m.messageId, record.result);
      await this.#refresh(r, m.messageId, generation); return;
    }
    if (record?.pending) { await record.pending; return; } // The original request sends one correlated result.
    if (r.busy) return this.#error(r, m.messageId, 'BRIDGE_BUSY');
    if (r.needsSync) return this.#error(r, m.messageId, 'RESYNC_REQUIRED');
    if (!record) {
      record = { signature, body: { requestId: `bridge:${r.channel}:${m.messageId}`, ...m.payload.action, expectedVersion: r.snapshot.version } };
      r.requests.set(m.messageId, record);
    }
    r.busy = true;
    record.pending = this.#execute(r, m.messageId, record, generation);
    try { await record.pending; }
    finally {
      record.pending = null;
      if (this.#active(r, generation)) {
        r.busy = false;
        while (r.requests.size > 128) r.requests.delete(r.requests.keys().next().value);
      }
    }
  }
  async #execute(r, id, record, generation) {
    try {
      const response = await this.#fetch(`/api/sdk/matches/${encodeURIComponent(r.matchId)}/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record.body),
      });
      const result = validateResult(await response.json());
      if (result.snapshot && (result.snapshot.matchId !== r.matchId || result.snapshot.gameId !== r.gameId)) throw new BridgeError('INVALID_HTTP_RESULT');
      if (!this.#active(r, generation)) return;
      record.result = result;
      r.unresolved.delete(id);
      if (result.snapshot) this.#adopt(r, result.snapshot);
      this.#send(r, 'ACTION_RESULT', id, result);
    } catch {
      if (!this.#active(r, generation)) return;
      r.needsSync = true; r.unresolved.add(id); this.#error(r, id, 'RESULT_UNKNOWN', true);
    }
    if (this.#active(r, generation)) await this.#refresh(r, id, generation);
  }
}
