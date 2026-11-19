import { GameSessionFactory } from './session-factory.mjs';
import { copyJSON, requireSDK, SDKError } from './values.mjs';

/** Phase 2A: preparation, inspection and cleanup only; no action/event runtime. */
export class GameInstanceManager {
  #factory;
  #instances = new Map();
  #pending = 0;
  #limit;

  constructor(factory, { limit = 500 } = {}) {
    requireSDK(factory instanceof GameSessionFactory && Number.isInteger(limit) && limit >= 1 && limit <= 500,
      'INVALID_CONFIGURATION', 'Se requiere fábrica y límite entre 1 y 500.');
    this.#factory = factory;
    this.#limit = limit;
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
    const next = entry.queue.then(() => operation(entry));
    entry.queue = next.catch(() => {});
    return next;
  }

  getSnapshot(matchId) {
    return this.#enqueue(matchId, async (entry) => {
      if (entry.state === 'finished') return this.#snapshot(entry, entry.finalData);
      entry.lastData = await entry.prepared.readData();
      return this.#snapshot(entry, entry.lastData);
    });
  }

  async list() {
    return Promise.all([...this.#instances.keys()].map((id) => this.getSnapshot(id)));
  }

  finish(matchId, { reason = 'cancelled' } = {}) {
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 128 || /[\u0000-\u001f\u007f]/u.test(reason)) {
      return Promise.reject(new SDKError('INVALID_CONFIGURATION', 'Motivo de cierre inválido.'));
    }
    return this.#enqueue(matchId, async (entry) => {
      if (entry.state === 'finished') return this.#snapshot(entry, entry.finalData);
      let snapshotError;
      try { entry.lastData = await entry.prepared.readData(); } catch (error) { snapshotError = error; }
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
