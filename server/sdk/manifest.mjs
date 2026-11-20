import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_BYTES = 64 * 1024;

export class ManifestError extends Error {
  constructor(code, field, message) {
    super(`${field}: ${message}`);
    this.name = 'ManifestError';
    this.code = code;
    this.field = field;
  }
}

function fail(field, message, code = 'INVALID_MANIFEST') {
  throw new ManifestError(code, field, message);
}

function object(value, allowed, required, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(field, 'se requiere un objeto JSON');
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(field, 'contiene campos desconocidos');
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    fail(field, 'faltan campos obligatorios');
  }
}

function string(value, max, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
      || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(field, `se requiere texto de 1 a ${max} caracteres, sin controles ni espacios exteriores`);
  }
}

function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(field, `se requiere entero entre ${min} y ${max}`);
  }
}

function relativeFile(value, extension, field) {
  string(value, 240, field);
  const segments = value.split('/');
  if (segments.some((part) => !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)
      || part.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
      || !value.endsWith(extension)) {
    fail(field, `se requiere ruta relativa con /, sin traversal y terminada en ${extension}`, 'UNSAFE_PATH');
  }
}

function option(value, index) {
  const field = `options[${index}]`;
  const common = ['id', 'label', 'description', 'type', 'default'];
  const extra = { boolean: [], integer: ['min', 'max', 'values'], string: ['minLength', 'maxLength'], enum: ['values'] };
  // Validate the discriminant before selecting the permitted keys.
  if (!value || !Object.hasOwn(extra, value.type)) fail(field, 'tipo de opción no compatible');
  object(value, [...common, ...extra[value.type]],
    ['id', 'label', 'type', 'default', ...(value.type === 'integer' ? [] : extra[value.type])], field);
  string(value.id, 64, `${field}.id`);
  if (!ID.test(value.id)) fail(`${field}.id`, 'identificador no seguro');
  string(value.label, 80, `${field}.label`);
  if (Object.hasOwn(value, 'description')) string(value.description, 500, `${field}.description`);
  switch (value.type) {
    case 'boolean':
      if (typeof value.default !== 'boolean') fail(`${field}.default`, 'se requiere booleano');
      break;
    case 'integer': {
      const discrete = Object.hasOwn(value, 'values');
      const hasMin = Object.hasOwn(value, 'min');
      const hasMax = Object.hasOwn(value, 'max');
      if (discrete ? (hasMin || hasMax) : (!hasMin || !hasMax)) {
        fail(field, 'debe declarar solo values o bien min y max juntos');
      }
      if (discrete) {
        if (!Array.isArray(value.values) || value.values.length < 1 || value.values.length > 32) {
          fail(`${field}.values`, 'se requieren entre 1 y 32 enteros distintos');
        }
        value.values.forEach((item) => integer(item, -1_000_000, 1_000_000, `${field}.values`));
        integer(value.default, -1_000_000, 1_000_000, `${field}.default`);
        if (new Set(value.values).size !== value.values.length || !value.values.includes(value.default)) {
          fail(field, 'valores repetidos o default fuera de values');
        }
      } else {
        integer(value.min, -1_000_000, 1_000_000, `${field}.min`);
        integer(value.max, value.min, 1_000_000, `${field}.max`);
        integer(value.default, value.min, value.max, `${field}.default`);
      }
      break;
    }
    case 'string':
      integer(value.minLength, 1, 256, `${field}.minLength`);
      integer(value.maxLength, value.minLength, 256, `${field}.maxLength`);
      string(value.default, value.maxLength, `${field}.default`);
      if (value.default.length < value.minLength) fail(`${field}.default`, 'texto demasiado corto');
      break;
    case 'enum':
      if (!Array.isArray(value.values) || value.values.length < 1 || value.values.length > 32) {
        fail(`${field}.values`, 'se requieren entre 1 y 32 valores');
      }
      value.values.forEach((item) => string(item, 80, `${field}.values`));
      if (new Set(value.values).size !== value.values.length || !value.values.includes(value.default)) {
        fail(field, 'valores repetidos o default fuera de values');
      }
      break;
  }
}

/** Validate parsed JSON, without filesystem access or plugin imports. Returns a copy. */
export function validateManifest(value) {
  const fields = ['manifestVersion', 'sdkVersion', 'id', 'name', 'version', 'description',
    'category', 'entrypoints', 'capabilities', 'players', 'analytics', 'options'];
  object(value, fields, fields.filter((key) => key !== 'analytics'), 'manifest');
  if (value.manifestVersion !== 1 || value.sdkVersion !== '1.0') {
    fail('manifest', 'solo manifestVersion: 1 y sdkVersion: "1.0" son compatibles', 'INCOMPATIBLE_VERSION');
  }
  string(value.id, 64, 'id');
  if (!ID.test(value.id)) fail('id', 'identificador no seguro');
  string(value.name, 80, 'name');
  string(value.version, 32, 'version');
  if (!VERSION.test(value.version)) fail('version', 'se requiere versión estable MAJOR.MINOR.PATCH');
  string(value.description, 1000, 'description');
  string(value.category, 64, 'category');
  if (!ID.test(value.category)) fail('category', 'se requiere un slug seguro');
  object(value.entrypoints, ['server', 'web'], ['server', 'web'], 'entrypoints');
  relativeFile(value.entrypoints.server, '.mjs', 'entrypoints.server');
  relativeFile(value.entrypoints.web, '.html', 'entrypoints.web');
  const capabilities = ['pause', 'resume', 'multipleInstances', 'ai'];
  object(value.capabilities, capabilities, capabilities, 'capabilities');
  for (const key of capabilities) {
    if (typeof value.capabilities[key] !== 'boolean') fail(`capabilities.${key}`, 'se requiere booleano');
  }
  if (value.capabilities.pause !== value.capabilities.resume) {
    fail('capabilities', 'pause y resume deben habilitarse o deshabilitarse juntos');
  }
  object(value.players, ['min', 'max'], ['min', 'max'], 'players');
  integer(value.players.min, 1, 16, 'players.min');
  integer(value.players.max, value.players.min, 16, 'players.max');
  if (Object.hasOwn(value, 'analytics')) {
    object(value.analytics, ['profile'], ['profile'], 'analytics');
    relativeFile(value.analytics.profile, '.json', 'analytics.profile');
  }
  if (!Array.isArray(value.options) || value.options.length > 32) fail('options', 'se requiere arreglo de hasta 32 opciones');
  value.options.forEach(option);
  if (new Set(value.options.map((item) => item.id)).size !== value.options.length) {
    fail('options', 'IDs de opciones duplicados');
  }
  return structuredClone(value);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function resolveFile(root, relative, field) {
  try {
    const target = await realpath(path.resolve(root, relative));
    if (!contained(root, target)) fail(field, 'la ruta real sale del paquete', 'UNSAFE_PATH');
    if (!(await stat(target)).isFile()) fail(field, 'se requiere un archivo regular', 'INVALID_PATH');
    return target;
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    fail(field, 'archivo inexistente o no accesible', 'INVALID_PATH');
  }
}

/** Read at most 64 KiB; validate real paths, never execute the entrypoints. */
export async function loadManifest(pluginDirectory) {
  let directory;
  try {
    directory = await realpath(pluginDirectory);
    if (!(await stat(directory)).isDirectory()) throw new Error();
  } catch {
    fail('plugin', 'directorio inexistente o no accesible', 'INVALID_PATH');
  }
  const manifestPath = await resolveFile(directory, 'game.json', 'game.json');
  let source;
  try {
    const handle = await open(manifestPath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_BYTES) fail('game.json', 'supera el límite de 64 KiB', 'INVALID_JSON');
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    fail('game.json', 'no se pudo leer JSON UTF-8', 'INVALID_JSON');
  }
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail('game.json', 'JSON inválido', 'INVALID_JSON'); }
  const manifest = validateManifest(parsed);
  const paths = {
    server: await resolveFile(directory, manifest.entrypoints.server, 'entrypoints.server'),
    web: await resolveFile(directory, manifest.entrypoints.web, 'entrypoints.web'),
  };
  if (manifest.analytics) paths.profile = await resolveFile(directory, manifest.analytics.profile, 'analytics.profile');
  return { manifest, directory, paths };
}
