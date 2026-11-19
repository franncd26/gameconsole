import { GameSessionFactory } from './session-factory.mjs';
import { GameEventAdapter } from './event-adapter.mjs';
import { copyJSON, requireSDK, SDKError } from './values.mjs';

/** Local lifecycle only; no HTTP, public dispatch or domain-event coordinator. */
export class GameInstanceManager {
  #factory;
  #instances = new Map();
  #pending = 0;
  #limit;
  #acceptEvent;

  constructor(factory, { limit = 500, eventSink } = {}) {
    requireSDK(factory instanceof GameSessionFactory && Number.isInteger(limit) && limit >= 1 && limit <= 500,
      'INVALID_CONFIGURATION', 'Se requiere fábrica y límite entre 1 y 500.');
    this.#factory = factory;
    this.#limit = limit;
    requireSDK(eventSink === undefined || typeof eventSink?.accept === 'function',
      'INVALID_CONFIGURATION', 'EventSink debe implementar accept(event).');
    this.#acceptEvent = eventSink?.accept.bind(eventSink);
  }

  get size() { return this.#instances.size; }

  async create(gameId, configuration = {}) {
    requireSDK(this.size + this.#pending < this.#limit, 'INSTANCE_LIMIT', 'Se alcanzó el límite de partidas de esta sesión.');
    this.#pending++;
    let prepared;
    try {
      prepared = await this.#factory.prepare(gameId, configuration);
      const data = await prepared.readData();
      requireSDK(prepared.manifest.capabilities.multipleInstances || ![...this.#instances.values()]
        .some((entry) => entry.prepared.manifest.id === gameId && entry.state !== 'finished'),
      'MULTIPLE_INSTANCES_DISABLED', 'Este plugin solo admite una instancia sin finalizar.');
      requireSDK(!this.#instances.has(prepared.matchId), 'DUPLICATE_MATCH', 'La identidad de partida ya existe.');
      const entry = { prepared, state: 'prepared', version: 0, queue: Promise.resolve(), lastData: data, finalData: null };
      const snapshot = this.#snapshot(entry, data);
      this.#instances.set(prepared.matchId, entry);
      return snapshot;
    } catch (error) {
      if (prepared) { try { await prepared.dispose('initialization_failed'); } catch { /* Keep original failure. */ } }
      throw error;
    } finally {
      this.#pending--;
    }
  }

  #snapshot(entry, data) {
    const p = entry.prepared;
    return copyJSON({ matchId: p.matchId, gameId: p.manifest.id, gameVersion: p.manifest.version,
      state: entry.state, version: entry.version, players: p.players,
      options: p.options, startData: p.startData, data });
  }

  #enqueue(matchId, operation) {
    const entry = this.#instances.get(matchId);
    if (!entry) return Promise.reject(new SDKError('UNKNOWN_MATCH', 'La partida no existe.'));
    const next = entry.queue.then(() => {
      requireSDK(this.#instances.get(matchId) === entry, 'UNKNOWN_MATCH', 'La preparación fue descartada.');
      return operation(entry);
    });
    entry.queue = next.catch(() => {});
    return next;
  }

  getSnapshot(matchId) {
    return this.#enqueue(matchId, async (entry) => {
      if (['closing', 'finished'].includes(entry.state)) return this.#snapshot(entry, entry.finalData);
      await this.#read(entry);
      return this.#snapshot(entry, entry.lastData);
    });
  }

  async #read(entry) {
    const data = await entry.prepared.readData();
    this.#snapshot(entry, data); // Validate the composed envelope before replacing the diagnostic copy.
    entry.lastData = data;
  }

  async list() {
    return Promise.all([...this.#instances.keys()].map((id) => this.getSnapshot(id)));
  }

  async #accept(event) {
    requireSDK(this.#acceptEvent, 'EVENT_SINK_UNAVAILABLE', 'No se configuró un EventSink local.');
    try { await this.#acceptEvent(event); }
    catch { throw new SDKError('EVENT_ACCEPTANCE_FAILED', 'El EventSink no aceptó el evento localmente.'); }
  }

  #adapter(entry) {
    const p = entry.prepared;
    return new GameEventAdapter({ gameId: p.manifest.id, gameVersion: p.manifest.version,
      matchId: p.matchId, players: p.players });
  }

  async #discard(entry, reason) {
    requireSDK(entry.state === 'prepared', 'INVALID_LIFECYCLE', 'Solo se puede descartar una preparación no activada.');
    entry.state = 'discarding';
    try { await entry.prepared.dispose(reason); }
    finally { this.#instances.delete(entry.prepared.matchId); }
  }

  discard(matchId) {
    return this.#enqueue(matchId, (entry) => this.#discard(entry, 'preparation_discarded'));
  }

  activate(matchId) {
    return this.#enqueue(matchId, async (entry) => {
      if (entry.state === 'running') return this.#snapshot(entry, entry.lastData);
      requireSDK(entry.state === 'prepared', 'INVALID_LIFECYCLE', 'La sesión no puede activarse en su estado actual.');
      let runningSnapshot;
      try {
        entry.prepared.setLifecyclePhase('activating');
        await this.#read(entry);
        runningSnapshot = this.#snapshot({ ...entry, state: 'running' }, entry.lastData);
        const event = this.#adapter(entry).createMatchStarted(entry.prepared.startData);
        await this.#accept(event);
      } catch (error) {
        const failure = new SDKError('ACTIVATION_FAILED', 'No se aceptó el inicio; la preparación fue descartada.');
        failure.failureCode = error instanceof SDKError ? error.code : 'INVALID_ACTIVATION';
        try { await this.#discard(entry, 'activation_failed'); }
        catch { failure.cleanupErrorCode = 'CLEANUP_FAILED'; }
        throw failure;
      }
      // No plugin calls or awaits after acceptance: publication cannot fail in a hook.
      entry.prepared.setLifecyclePhase('running');
      entry.state = 'running';
      return runningSnapshot;
    });
  }

  finish(matchId, { reason = 'cancelled' } = {}) {
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 128 || /[\u0000-\u001f\u007f]/u.test(reason)) {
      return Promise.reject(new SDKError('INVALID_CONFIGURATION', 'Motivo de cierre inválido.'));
    }
    return this.#enqueue(matchId, async (entry) => {
      if (entry.state === 'finished') return this.#snapshot(entry, entry.finalData);
      if (entry.state === 'running' || entry.state === 'closing') {
        if (entry.state === 'running') {
          try { await this.#read(entry); } catch (error) { entry.snapshotError = error; }
          entry.finalData = entry.lastData;
          entry.closeEvent = this.#adapter(entry).createMatchFinished({ reason });
          entry.state = 'closing';
          entry.prepared.setLifecyclePhase('closing');
          try { await entry.prepared.dispose(reason); } catch (error) { entry.cleanupError = error; }
        }
        // Retain this exact envelope on rejection. The sink must reject without retaining it.
        await this.#accept(entry.closeEvent);
        entry.state = 'finished';
        entry.version++;
        if (entry.cleanupError) throw entry.cleanupError;
        if (entry.snapshotError) throw entry.snapshotError;
        return this.#snapshot(entry, entry.finalData);
      }
      let snapshotError;
      try { await this.#read(entry); } catch (error) { snapshotError = error; }
      entry.finalData = entry.lastData;
      // Terminal snapshot is an immutable report, not a second game-state engine.
      entry.state = 'finished';
      entry.version++;
      await entry.prepared.dispose(reason);
      if (snapshotError) throw snapshotError;
      return this.#snapshot(entry, entry.finalData);
    });
  }
}
