import { randomUUID } from 'node:crypto';
import { copyJSON, freezeJSON, isObject, requireSDK } from './values.mjs';

const RESERVED = new Set(['MATCH_STARTED', 'MATCH_FINISHED']);
const START_RESERVED = ['players', 'gameId', 'gameVersion', 'matchId', 'schemaVersion', 'eventId', 'timestamp'];
const text = (value) => typeof value === 'string' && value.trim().length > 0
  && !/[\u0000-\u001f\u007f]/u.test(value);

/** Builds immutable v1 envelopes. Only host code receives this adapter. No I/O. */
export class GameEventAdapter {
  #identity;

  constructor({ gameId, gameVersion, matchId, players }) {
    const identity = copyJSON({ gameId, gameVersion, matchId, players }, 'INVALID_EVENT_IDENTITY');
    requireSDK([gameId, gameVersion, matchId].every(text) && Array.isArray(identity.players)
      && identity.players.length > 0 && identity.players.every((player) => isObject(player) && text(player.id))
      && new Set(identity.players.map((player) => player.id)).size === identity.players.length,
    'INVALID_EVENT_IDENTITY', 'Se requiere identidad y participantes asignados por el anfitrión.');
    this.#identity = freezeJSON(identity);
  }

  #build(type, data, playerId) {
    const copied = copyJSON(data, 'INVALID_EVENT');
    requireSDK(isObject(copied) && typeof type === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(type),
      'INVALID_EVENT', 'El evento requiere tipo y objeto data válidos.');
    if (playerId !== undefined) {
      requireSDK(typeof playerId === 'string' && this.#identity.players.some((player) => player.id === playerId),
        'INVALID_EVENT_PLAYER', 'El playerId no pertenece a esta partida.');
    }
    const event = {
      schemaVersion: 1, eventId: randomUUID(), timestamp: new Date().toISOString(),
      gameId: this.#identity.gameId, gameVersion: this.#identity.gameVersion,
      matchId: this.#identity.matchId, type, data: copied,
      ...(playerId === undefined ? {} : { playerId }),
    };
    requireSDK(Buffer.byteLength(JSON.stringify(event), 'utf8') <= 1024 * 1024,
      'EVENT_TOO_LARGE', 'El sobre supera el límite de 1 MiB de GameStats v1.');
    return freezeJSON(event);
  }

  createMatchStarted(startData) {
    const data = copyJSON(startData, 'INVALID_EVENT');
    requireSDK(isObject(data) && START_RESERVED.every((key) => !Object.hasOwn(data, key)),
      'INVALID_EVENT', 'Los datos de inicio no pueden sustituir participantes ni identidad.');
    return this.#build('MATCH_STARTED', { ...data, players: this.#identity.players.map((player) => player.id) });
  }

  createMatchFinished({ reason }) {
    requireSDK(text(reason) && reason.length <= 128, 'INVALID_EVENT', 'Se requiere un motivo de cierre válido.');
    return this.#build('MATCH_FINISHED', { reason });
  }

  /** Builds a domain envelope; publication belongs exclusively to the host coordinator. */
  createDomainEvent(input) {
    const descriptor = copyJSON(input, 'INVALID_EVENT');
    requireSDK(isObject(descriptor) && Object.hasOwn(descriptor, 'type') && Object.hasOwn(descriptor, 'data')
      && Object.keys(descriptor).every((key) => ['type', 'data', 'playerId'].includes(key)),
    'INVALID_EVENT', 'El plugin solo puede proponer type, data y playerId.');
    requireSDK(!RESERVED.has(descriptor.type), 'RESERVED_EVENT', 'Los eventos de ciclo de vida pertenecen al anfitrión.');
    if (Object.hasOwn(descriptor, 'playerId')) {
      requireSDK(typeof descriptor.playerId === 'string', 'INVALID_EVENT_PLAYER', 'playerId debe identificar un participante.');
    }
    return this.#build(descriptor.type, descriptor.data, descriptor.playerId);
  }
}
