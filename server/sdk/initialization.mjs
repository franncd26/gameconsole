import { copyJSON, freezeJSON, isObject, requireSDK } from './values.mjs';

const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array', 'playerId'];
const RESERVED = ['players', 'gameId', 'gameVersion', 'matchId', 'schemaVersion', 'eventId', 'timestamp'];
const validToken = (value) => typeof value === 'string' && value.length <= 64 && TOKEN.test(value);
const exact = (value, keys) => isObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

export function validateInitializationContract(value, manifest) {
  const contract = copyJSON(value, 'INVALID_PLUGIN_INTERFACE');
  const check = (condition) => requireSDK(condition, 'INVALID_PLUGIN_INTERFACE', 'Contrato declarativo de inicialización inválido.');
  check(exact(contract, ['participants', 'startData']));
  check(Array.isArray(contract.participants) && contract.participants.length >= manifest.players.min
    && contract.participants.length <= 16);
  for (const player of contract.participants) {
    check(exact(player, ['id', 'role', 'required']) && validToken(player.id)
      && validToken(player.role) && typeof player.required === 'boolean');
  }
  check(new Set(contract.participants.map((player) => player.id)).size === contract.participants.length);
  check(contract.participants.filter((player) => player.required).length <= manifest.players.max);
  check(isObject(contract.startData) && Object.keys(contract.startData).length <= 32);
  for (const [field, rule] of Object.entries(contract.startData)) {
    check(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field) && !RESERVED.includes(field));
    check(isObject(rule) && Object.hasOwn(rule, 'type') && Object.hasOwn(rule, 'required')
      && Object.keys(rule).every((key) => ['type', 'required', 'equalsOption'].includes(key))
      && TYPES.includes(rule.type) && typeof rule.required === 'boolean');
    if (Object.hasOwn(rule, 'equalsOption')) {
      const option = manifest.options.find((candidate) => candidate.id === rule.equalsOption);
      const compatible = { string: ['string', 'enum'], playerId: ['string', 'enum'],
        integer: ['integer'], number: ['integer'], boolean: ['boolean'], object: [], array: [] };
      check(typeof rule.equalsOption === 'string' && option && compatible[rule.type].includes(option.type));
    }
  }
  return freezeJSON(contract);
}

export function validatePlayers(contract, manifest, input) {
  const players = input === undefined
    ? contract.participants.filter((player) => player.required).map(({ id, role }) => ({ id, role }))
    : copyJSON(input, 'INVALID_PLAYERS');
  const check = (condition) => requireSDK(condition, 'INVALID_PLAYERS', 'Participantes incompatibles con el manifiesto o contrato.');
  check(Array.isArray(players) && players.length >= manifest.players.min && players.length <= manifest.players.max);
  for (const player of players) {
    check(exact(player, ['id', 'role']) && contract.participants.some((allowed) => allowed.id === player.id && allowed.role === player.role));
  }
  check(new Set(players.map((player) => player.id)).size === players.length);
  check(contract.participants.every((allowed) => !allowed.required || players.some((player) => player.id === allowed.id)));
  return freezeJSON(players);
}

export function validateStartData(contract, value, options, players) {
  const data = copyJSON(value, 'INVALID_START_DATA');
  const check = (condition) => requireSDK(condition, 'INVALID_START_DATA', 'Los datos de inicio no cumplen el contrato declarado.');
  check(isObject(data) && Object.keys(data).every((field) => Object.hasOwn(contract.startData, field)));
  for (const [field, rule] of Object.entries(contract.startData)) {
    const present = Object.hasOwn(data, field);
    check(present || !rule.required);
    if (!present) continue;
    const item = data[field];
    const types = {
      string: typeof item === 'string', integer: Number.isSafeInteger(item),
      number: typeof item === 'number' && Number.isFinite(item), boolean: typeof item === 'boolean',
      object: isObject(item), array: Array.isArray(item),
      playerId: typeof item === 'string' && players.some((player) => player.id === item),
    };
    check(types[rule.type]);
    if (Object.hasOwn(rule, 'equalsOption')) check(item === options[rule.equalsOption]);
  }
  return freezeJSON(data);
}
