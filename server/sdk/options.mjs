import { validateManifest } from './manifest.mjs';
import { copyJSON, freezeJSON, isObject, requireSDK, SDKError } from './values.mjs';

/** Defaults and value checking share the normative manifest validator. */
export function validateOptions(manifest, input = {}) {
  const declarations = validateManifest(manifest);
  const supplied = copyJSON(input, 'INVALID_OPTIONS');
  requireSDK(isObject(supplied), 'INVALID_OPTIONS', 'Las opciones deben ser un objeto JSON.');
  const ids = new Set(declarations.options.map((option) => option.id));
  requireSDK(Object.keys(supplied).every((id) => ids.has(id)), 'INVALID_OPTIONS', 'Hay opciones no declaradas.');
  declarations.options = declarations.options.map((option) => ({
    ...option, default: Object.hasOwn(supplied, option.id) ? supplied[option.id] : option.default,
  }));
  try {
    validateManifest(declarations);
  } catch {
    throw new SDKError('INVALID_OPTIONS', 'Una opción no cumple el tipo o los valores declarados.');
  }
  return freezeJSON(Object.fromEntries(declarations.options.map((option) => [option.id, option.default])));
}
