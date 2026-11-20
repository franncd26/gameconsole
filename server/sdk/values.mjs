export class SDKError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SDKError';
    this.code = code;
  }
}

export function requireSDK(condition, code, message) {
  if (!condition) throw new SDKError(code, message);
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Copy JSON without invoking getters/toJSON or silently dropping invalid values. */
export function copyJSON(value, code = 'INVALID_JSON_VALUE') {
  const ancestors = new Set();
  function copy(item, depth) {
    const reject = () => { throw new SDKError(code, 'Se requiere JSON finito, sin ciclos, accesores ni tipos especiales (profundidad máxima 64).'); };
    if (depth > 64) reject();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) reject(); return item; }
    if (typeof item !== 'object' || (!Array.isArray(item) && !isObject(item)) || ancestors.has(item)) reject();
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) reject();
    let result;
    if (Array.isArray(item)) {
      if (keys.length !== item.length + 1) reject();
      result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      result = Object.fromEntries(keys.map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
        return [key, copy(descriptor.value, depth + 1)];
      }));
    }
    ancestors.delete(item);
    return result;
  }
  return copy(value, 0);
}

export function freezeJSON(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeJSON);
    Object.freeze(value);
  }
  return value;
}
