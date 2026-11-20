import { GameSessionFactory } from './session-factory.mjs';
import { GameEventAdapter } from './event-adapter.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateAction, actionFingerprint } from './actions.mjs';
import { copyJSON, freezeJSON, isObject, requireSDK, SDKError } from './values.mjs';

/** JSON action facade and host-internal coordinator; no HTTP or client authentication. */
export class GameInstanceManager {
  #factory;
  #instances = new Map();
  #pending = 0;
  #limit;
  #acceptEvent;
  #acceptBatch;
  #operationScope = new AsyncLocalStorage();
  #requestHistoryLimit;

  constructor(factory, { limit = 500, eventSink, requestHistoryLimit = 128 } = {}) {
    requireSDK(factory instanceof GameSessionFactory && Number.isInteger(limit) && limit >= 1 && limit <= 500,
      'INVALID_CONFIGURATION', 'Se requiere fábrica y límite entre 1 y 500.');
    this.#factory = factory;
    this.#limit = limit;
    requireSDK(Number.isSafeInteger(requestHistoryLimit) && requestHistoryLimit >= 1 && requestHistoryLimit <= 1024,
      'INVALID_CONFIGURATION', 'El historial de solicitudes debe estar entre 1 y 1024 entradas por partida.');
    this.#requestHistoryLimit = requestHistoryLimit;
    requireSDK(eventSink === undefined || typeof eventSink?.accept === 'function',
      'INVALID_CONFIGURATION', 'EventSink debe implementar accept(event).');
    requireSDK(eventSink?.acceptBatch === undefined || typeof eventSink.acceptBatch === 'function',
      'INVALID_CONFIGURATION', 'acceptBatch debe ser una función cuando se declara.');
    this.#acceptEvent = eventSink?.accept.bind(eventSink);
    this.#acceptBatch = eventSink?.acceptBatch?.bind(eventSink);
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
      const entry = { prepared, state: 'prepared', version: 0, queue: Promise.resolve(), lastData: data, finalData: null,
        requests: new Map(), inFlightRequests: new Map() };
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
    if (this.#operationScope.getStore()?.entry === entry) {
      return Promise.reject(new SDKError('REENTRANT_OPERATION', 'No se puede esperar recursivamente la cola de esta partida.'));
    }
    const next = entry.queue.then(() => {
      requireSDK(this.#instances.get(matchId) === entry, 'UNKNOWN_MATCH', 'La preparación fue descartada.');
      // Lifecycle/sink callbacks also must not await the queue they are currently holding.
      return this.#operationScope.run({ entry }, () => operation(entry));
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
    return this.#enqueue(matchId, (entry) => this.#finishEntry(entry, reason));
  }

  async #finishEntry(entry, reason) {
    if (entry.state === 'finished') return this.#snapshot(entry, entry.finalData);
    requireSDK(Number.isSafeInteger(entry.version + 1), 'VERSION_LIMIT', 'Se alcanzó el límite de versión.');
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
  }

  #dispatchRejection(entry, code) {
    const messages = {
      INVALID_ACTION: 'Sobre de acción inválido; solo se admiten los campos y tipos JSON del contrato.',
      UNKNOWN_MATCH: 'La partida no existe.',
      REENTRANT_OPERATION: 'No se puede esperar recursivamente la cola de esta partida.',
      REQUEST_CONFLICT: 'requestId ya identifica una solicitud de contenido diferente.',
      VERSION_CONFLICT: 'expectedVersion no coincide con la versión pública vigente.',
      INVALID_LIFECYCLE: 'Solo running permite ejecutar una acción nueva.',
      COORDINATED_STATE_REQUIRED: 'El plugin no declaró una celda coordinada.',
    };
    return { outcome: 'rejected', committed: false, confirmations: 0,
      snapshot: entry ? this.#snapshot(entry, ['closing', 'finished'].includes(entry.state) ? entry.finalData : entry.lastData) : null,
      error: { code, message: messages[code] } };
  }

  #queueDispatch(matchId, execute) {
    return this.#enqueue(matchId, execute).catch((error) => {
      if (['UNKNOWN_MATCH', 'REENTRANT_OPERATION'].includes(error?.code)) {
        return this.#dispatchRejection(this.#instances.get(matchId), error.code);
      }
      // Unexpected host faults must not be reported as an uncommitted action or expose internal traces/messages.
      throw new SDKError('DISPATCH_FAILED', 'Falló la infraestructura de acciones; consulta el snapshot antes de continuar.');
    });
  }

  #rememberRequest(entry, action, fingerprint, result) {
    // Host-generated envelopes already contain validated JSON; clone without reapplying the payload depth budget to wrappers.
    entry.requests.set(action.requestId, { fingerprint, result: freezeJSON(structuredClone(result)) });
    if (entry.requests.size > this.#requestHistoryLimit) entry.requests.delete(entry.requests.keys().next().value);
  }

  async #dispatchEntry(entry, action, fingerprint) {
    const prior = entry.requests.get(action.requestId);
    if (prior) return prior.fingerprint === fingerprint ? structuredClone(prior.result) : this.#dispatchRejection(entry, 'REQUEST_CONFLICT');
    if (entry.state !== 'running') return this.#dispatchRejection(entry, 'INVALID_LIFECYCLE');
    if (!entry.prepared.hasCoordinatedState) return this.#dispatchRejection(entry, 'COORDINATED_STATE_REQUIRED');
    const result = Object.hasOwn(action, 'expectedVersion') && action.expectedVersion !== entry.version
      ? this.#dispatchRejection(entry, 'VERSION_CONFLICT')
      : await this.#runOperation(entry, (session) => session.dispatch(action));
    this.#rememberRequest(entry, action, fingerprint, result);
    return result;
  }

  /** Public data-only API. Pending duplicates share a promise, never a second operation queue. */
  async dispatch(matchId, input) {
    let action, fingerprint;
    try { action = validateAction(input); fingerprint = actionFingerprint(action); } catch { /* Return a sanitized JSON rejection below. */ }
    const entry = this.#instances.get(matchId);
    if (!entry) return this.#dispatchRejection(null, action ? 'UNKNOWN_MATCH' : 'INVALID_ACTION');
    if (this.#operationScope.getStore()?.entry === entry) return this.#dispatchRejection(entry, 'REENTRANT_OPERATION');
    if (!action) return this.#queueDispatch(matchId, (current) => this.#dispatchRejection(current, 'INVALID_ACTION'));
    const pending = entry.inFlightRequests.get(action.requestId);
    if (pending) {
      return pending.fingerprint === fingerprint ? structuredClone(await pending.promise)
        : this.#queueDispatch(matchId, (current) => this.#dispatchRejection(current, 'REQUEST_CONFLICT'));
    }
    const record = { fingerprint, promise: this.#queueDispatch(matchId, (current) => this.#dispatchEntry(current, action, fingerprint)) };
    entry.inFlightRequests.set(action.requestId, record);
    try { return structuredClone(await record.promise); }
    finally { if (entry.inFlightRequests.get(action.requestId) === record) entry.inFlightRequests.delete(action.requestId); }
  }

  /** Trusted host/test entry point; deliberately no public action envelope or dispatch endpoint. */
  runOperation(matchId, operation) {
    if (typeof operation !== 'function') return Promise.reject(new SDKError('INVALID_CONFIGURATION', 'Se requiere una operación interna.'));
    return this.#enqueue(matchId, (entry) => this.#runOperation(entry, operation));
  }

  async #runOperation(entry, operation) {
      requireSDK(entry.state === 'running', 'INVALID_LIFECYCLE', 'Solo running permite operaciones de dominio.');
      const p = entry.prepared;
      let accepting = true;
      let failure;
      let operationFailed = false;
      let confirmations = 0;
      let confirmationPending = false;
      let finishReason;
      let tail = Promise.resolve();
      const errorInfo = (error) => ({ code: error.code, message: error.message });
      const bridge = {
        confirm: (input) => {
          if (confirmationPending) {
            const error = new SDKError('CONCURRENT_TRANSITION', 'Debe completar la confirmación pendiente antes de solicitar otra.');
            failure ??= error;
            const rejected = Promise.reject(error);
            rejected.catch(() => {}); // The operation records the failure even if the plugin ignores this promise.
            return rejected;
          }
          const priorFailure = failure;
          confirmationPending = true;
          let proposal, inputError;
          try {
            requireSDK(accepting, 'OPERATION_ENDED', 'La operación ya terminó.');
            requireSDK(finishReason === undefined, 'CLOSE_REQUESTED', 'Ya se solicitó cerrar esta partida.');
            proposal = copyJSON(input, 'INVALID_TRANSITION');
          } catch (error) { inputError = error; }
          const next = tail.then(async () => {
            if (priorFailure) throw priorFailure;
            if (inputError) throw inputError;
            requireSDK(entry.state === 'running' && isObject(proposal)
              && Object.keys(proposal).length === 2 && Object.hasOwn(proposal, 'data')
              && Array.isArray(proposal.events) && proposal.events.length <= 32,
            'INVALID_TRANSITION', 'Se requiere data y un arreglo de hasta 32 eventos.');
            requireSDK(Number.isSafeInteger(entry.version + 1), 'VERSION_LIMIT', 'Se alcanzó el límite de versión.');
            const data = p.stageTransition(proposal.data);
            const snapshot = this.#snapshot({ ...entry, version: entry.version + 1 }, data);
            const events = Object.freeze(proposal.events.map((descriptor) => this.#adapter(entry).createDomainEvent(descriptor)));
            if (events.length > 1) {
              requireSDK(this.#acceptBatch, 'BATCH_SINK_REQUIRED', 'Varios eventos requieren acceptBatch con aceptación local de lote completo.');
              try { await this.#acceptBatch(events); }
              catch { throw new SDKError('EVENT_ACCEPTANCE_FAILED', 'El EventSink no aceptó el lote localmente.'); }
            } else if (events.length === 1) await this.#accept(events[0]);
            // Nothing fallible or asynchronous, and no plugin callback, between state/version publication.
            p.publishTransition(data);
            entry.lastData = data;
            entry.version++;
            confirmations++;
            return { version: entry.version, snapshot };
          }).finally(() => { confirmationPending = false; });
          tail = next.catch((error) => {
            const codes = ['INVALID_TRANSITION', 'VERSION_LIMIT', 'INVALID_EVENT', 'RESERVED_EVENT',
              'INVALID_EVENT_PLAYER', 'EVENT_TOO_LARGE', 'BATCH_SINK_REQUIRED', 'EVENT_SINK_UNAVAILABLE',
              'EVENT_ACCEPTANCE_FAILED', 'CLOSE_REQUESTED', 'OPERATION_ENDED'];
            failure ??= new SDKError(codes.includes(error?.code) ? error.code : 'INVALID_TRANSITION',
              'No se pudo confirmar la transición solicitada.');
          });
          return next;
        },
        requestFinish: (input) => {
          requireSDK(accepting, 'OPERATION_ENDED', 'La operación ya terminó.');
          const request = copyJSON(input, 'INVALID_CONFIGURATION');
          requireSDK(isObject(request) && Object.keys(request).length === 1 && typeof request.reason === 'string'
            && request.reason.trim().length > 0 && request.reason.length <= 128
            && !/[\u0000-\u001f\u007f]/u.test(request.reason), 'INVALID_CONFIGURATION', 'Solicitud de cierre inválida.');
          finishReason ??= request.reason;
          return Promise.resolve({ requested: true });
        },
      };
      return p.withOperation(bridge, async (session) => {
        let result;
        try {
          result = await this.#operationScope.run({ entry }, () => operation(session));
        } catch {
          operationFailed = true;
        }
        accepting = false;
        await tail; // Includes confirmations submitted without await; failures cannot be hidden by the plugin.
        if (failure) operationFailed = false; // A rejected confirmation is already classified, not an external failure.
        let outcome;
        try {
          if (result !== undefined) {
            const reported = copyJSON(result, 'INVALID_OPERATION_RESULT');
            requireSDK(isObject(reported) && ['completed', 'rejected', 'dependency_failed'].includes(reported.outcome),
              'INVALID_OPERATION_RESULT', 'Resultado de operación incompatible.');
            outcome = reported.outcome;
          }
        } catch {
          failure ??= new SDKError('INVALID_OPERATION_RESULT', 'Resultado de operación incompatible.');
        }
        if (outcome === 'dependency_failed') operationFailed = true;
        if (outcome === 'rejected' && confirmations > 0) {
          failure ??= new SDKError('INVALID_OPERATION_RESULT', 'Una operación confirmada no puede declararse rechazada.');
        }
        let closeError;
        if (finishReason !== undefined && !failure && !operationFailed && outcome !== 'rejected') {
          try { await this.#finishEntry(entry, finishReason); }
          catch (error) { closeError = error; }
        }
        const error = closeError ?? failure ?? (operationFailed
          ? new SDKError('PLUGIN_OPERATION_FAILED', 'Falló la operación o dependencia del plugin.') : undefined);
        const snapshot = this.#snapshot(entry, ['closing', 'finished'].includes(entry.state) ? entry.finalData : entry.lastData);
        return {
          outcome: error ? (operationFailed || confirmations > 0 ? 'dependency_failed' : 'rejected')
            : outcome === 'rejected' ? 'rejected' : 'completed',
          committed: confirmations > 0, confirmations, snapshot,
          ...(error ? { error: errorInfo(error) } : {}),
        };
      });
  }
}
