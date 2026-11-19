import { copyJSON, freezeJSON, isObject, requireSDK, SDKError } from './values.mjs';

/** Copy before the first await; never invoke accessors or interpret payload as code. */
export function validateAction(input) {
  try {
    const action = copyJSON(input, 'INVALID_ACTION');
    requireSDK(isObject(action) && ['requestId', 'type', 'payload'].every((key) => Object.hasOwn(action, key))
      && Object.keys(action).every((key) => ['requestId', 'type', 'payload', 'expectedVersion'].includes(key))
      && typeof action.requestId === 'string' && action.requestId.length > 0 && action.requestId.length <= 128
      && !/\p{Cc}/u.test(action.requestId)
      && typeof action.type === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(action.type) && !/\p{Cc}/u.test(action.type)
      && isObject(action.payload)
      && (!Object.hasOwn(action, 'expectedVersion') || (Number.isSafeInteger(action.expectedVersion) && action.expectedVersion >= 0)),
    'INVALID_ACTION', 'Sobre de acción inválido.');
    return freezeJSON(action);
  } catch {
    throw new SDKError('INVALID_ACTION', 'La acción requiere requestId, type, payload JSON y expectedVersion opcional válidos, sin campos extra.');
  }
}

/** Canonical logical JSON: sorted object keys at every level; array order remains significant. */
export function actionFingerprint(action) {
  function encode(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  }
  return encode(action);
}
