import { mkdir, mkdtemp, writeFile, readFile, rename, rm, readdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadManifest } from '../manifest.mjs';
import { archive } from './archive.mjs';
import { ScalaActivator, checkProfile, importError } from './analytics.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const idOK = id => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64;
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function profileAt(record) {
  async function webFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw importError('INVALID_ARCHIVE', 'No se admiten enlaces en recursos web.');
      if (entry.isDirectory()) await webFiles(file);
      else if (!entry.isFile() || (await stat(file)).size > 1048576) throw importError('INVALID_ARCHIVE', 'Los recursos web deben ser archivos de hasta 1 MiB.');
    }
  }
  await webFiles(path.dirname(record.paths.web));
  if (!record.paths.profile) throw importError('INVALID_PROFILE', 'El paquete requiere analytics.profile.');
  const bytes = await readFile(record.paths.profile);
  if (bytes.length > 1048576) throw importError('INVALID_PROFILE', 'Perfil demasiado grande.');
  try { return { bytes, value: checkProfile(JSON.parse(bytes), record.manifest.id) }; }
  catch (e) { if (e.code === 'INVALID_PROFILE') throw e; throw importError('INVALID_PROFILE', 'Perfil JSON inválido.'); }
}
export class PluginImporter {
  #tail = Promise.resolve(); #previews = new Map();
  constructor(sdk, { storage, profiles, scalaURL, stateDirectory, activator } = {}) {
    if (!storage || !profiles || !path.isAbsolute(storage) || !path.isAbsolute(profiles) || storage === profiles) throw importError('IMPORT_CONFIGURATION', 'Configura directorios persistentes absolutos y separados.', 503);
    if (!activator && (!stateDirectory || !path.isAbsolute(stateDirectory))) throw importError('IMPORT_CONFIGURATION', 'Configura el acuse compartido del supervisor Scala.', 503);
    Object.assign(this, { sdk, storage, profiles, activator: activator || new ScalaActivator(scalaURL, { profilesDirectory: profiles, stateDirectory }) });
    this.issues = []; this.pending = 0;
  }
  serial(run) {
    if (this.pending >= 8) return Promise.reject(importError('IMPORT_BUSY', 'Hay demasiadas instalaciones pendientes.', 429));
    this.pending++; const next = this.#tail.then(run); this.#tail = next.catch(() => {});
    return next.finally(() => this.pending--);
  }
  async initialize() {
    const baseline = this.sdk.recoveryPackage();
    if (!baseline) throw importError('IMPORT_CONFIGURATION', 'Se requiere un perfil original para comprobar recuperación.', 503);
    this.recoveryProfile = (await profileAt(baseline)).value;
    for (const name of ['packages', 'enabled', 'transactions', 'staging']) await mkdir(path.join(this.storage, name), { recursive: true });
    await mkdir(this.profiles, { recursive: true });
    // These paths contain only importer-owned temporary uploads, never user source trees.
    for (const entry of await readdir(path.join(this.storage, 'staging'))) await rm(path.join(this.storage, 'staging', entry), { recursive: true, force: true });
    for (const name of await readdir(path.join(this.storage, 'transactions'))) {
      if (name.endsWith('.tmp')) { await rm(path.join(this.storage, 'transactions', name)); continue; }
      const id = name.replace(/\.json$/, ''); if (!idOK(id) || this.sdk.has(id)) continue;
      try {
      if (!await exists(path.join(this.storage, 'enabled', id + '.json'))) {
        const transaction = JSON.parse(await readFile(path.join(this.storage, 'transactions', name)));
        const target = path.join(this.profiles, id + '.json');
        if (await exists(target) && hash(await readFile(target)) === transaction.profileHash) await rm(target);
        await rm(path.join(this.storage, 'packages', id), { recursive: true, force: true });
      }
      await rm(path.join(this.storage, 'transactions', name));
      } catch { this.issues.push({ id, code: 'RECOVERY_JOURNAL_REJECTED' }); }
    }
    const receipts = await readdir(path.join(this.storage, 'enabled'));
    // Rebuild additions sequentially from receipts at boot. One invalid persisted
    // profile must not make verification of every other restored game fail.
    for (const name of receipts) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !idOK(id) || this.sdk.has(id)) continue;
      const file = path.join(this.profiles, id + '.json');
      if (await exists(file)) {
        let receipt; try { receipt = JSON.parse(await readFile(path.join(this.storage, 'enabled', name))); } catch {}
        if (hash(await readFile(file)) === receipt?.profileHash) await rm(file);
        else await rename(file, path.join(this.profiles, '.rejected-' + id + '-' + randomUUID() + '.bak'));
      }
    }
    for (const name of receipts) {
      const id = name.replace(/\.json$/, ''); if (!idOK(id) || !name.endsWith('.json')) continue;
      if (this.sdk.has(id)) { this.issues.push({ id, code: 'RECOVERY_DUPLICATE' }); continue; }
      try {
        const receipt = JSON.parse(await readFile(path.join(this.storage, 'enabled', name)));
        const directory = path.join(this.storage, 'packages', id), record = await loadManifest(directory), profile = await profileAt(record);
        if (record.manifest.id !== id || receipt.id !== id || receipt.profileHash !== hash(profile.bytes)) throw Error();
        const file = path.join(this.profiles, id + '.json');
        if (!await exists(file)) await writeFile(file, profile.bytes, { flag: 'wx', mode: 0o644 });
        if (hash(await readFile(file)) !== receipt.profileHash) throw Error();
        const candidate = await this.sdk.validatePackage(directory); await this.activator.verify(profile.value); await this.sdk.publishPackage(candidate);
      } catch {
        this.issues.push({ id, code: 'RECOVERY_REJECTED' }); // Academics remain available; never advertise partial activation.
        const file = path.join(this.profiles, id + '.json');
        if (!this.sdk.has(id)) await rm(file, { force: true });
      }
    }
  }
  async preview(bytes) {
    return this.serial(async () => {
      for (const [token, p] of this.#previews) if (p.expires < Date.now()) { await rm(p.stage, { recursive: true, force: true }); this.#previews.delete(token); }
      if (this.#previews.size >= 4) throw importError('IMPORT_BUSY', 'Confirma o espera que expiren las vistas previas.', 429);
      if (!Buffer.isBuffer(bytes) || bytes.length > 10 * 1024 * 1024 || !bytes.length) throw importError('ARCHIVE_TOO_LARGE', 'ZIP vacío o superior a 10 MiB.', 413);
      const stage = await mkdtemp(path.join(this.storage, 'staging', 'upload-'));
      try {
        const zip = path.join(stage, 'package.zip'); await writeFile(zip, bytes);
        const unpacked = path.join(stage, 'unpacked'); await mkdir(unpacked);
        const { folder } = await archive('extract', zip, unpacked), directory = path.join(unpacked, folder);
        const record = await loadManifest(directory), profile = await profileAt(record);
        if (this.sdk.has(record.manifest.id) || await exists(path.join(this.storage, 'packages', record.manifest.id))) throw importError('DUPLICATE_ID', 'Ya existe un paquete con ese ID.', 409);
        const token = randomUUID(); this.#previews.set(token, { stage, directory, record, profile, expires: Date.now() + 600000 });
        return { token, manifest: { id: record.manifest.id, name: record.manifest.name, version: record.manifest.version, description: record.manifest.description }, expiresInSeconds: 600 };
      } catch (e) { await rm(stage, { recursive: true, force: true }); throw e; }
    });
  }
  async install(token) {
    return this.serial(async () => {
      const preview = this.#previews.get(token); this.#previews.delete(token);
      if (!preview || preview.expires < Date.now()) {
        if (preview) await rm(preview.stage, { recursive: true, force: true });
        throw importError('PREVIEW_EXPIRED', 'Vista previa no disponible; selecciona el ZIP de nuevo.', 409);
      }
      const { stage, record, profile } = preview, id = record.manifest.id;
      const directory = path.join(this.storage, 'packages', id), target = path.join(this.profiles, id + '.json');
      const receipt = path.join(this.storage, 'enabled', id + '.json'), transaction = path.join(this.storage, 'transactions', id + '.json');
      let ownedDirectory = false, ownedProfile = false, ownedReceipt = false, ownedTransaction = false, committed = false, temporary;
      try {
        if (this.sdk.has(id) || await exists(directory) || await exists(target)) throw importError('DUPLICATE_ID', 'ID o perfil ya instalado; no se reemplaza.', 409);
        await writeFile(transaction + '.tmp', JSON.stringify({ id, profileHash: hash(profile.bytes) }), { flag: 'wx' });
        await rename(transaction + '.tmp', transaction);
        ownedTransaction = true;
        await rename(preview.directory, directory); ownedDirectory = true;
        const candidate = await this.sdk.validatePackage(directory);
        temporary = path.join(this.profiles, '.' + randomUUID() + '.tmp');
        await writeFile(temporary, profile.bytes, { mode: 0o644 }); await rename(temporary, target); ownedProfile = true;
        await this.activator.verify(profile.value); // Real /analyze, not health. No events are sent to Go by this probe.
        const tmpReceipt = receipt + '.tmp'; await writeFile(tmpReceipt, JSON.stringify({ id, profileHash: hash(profile.bytes), installedAt: new Date().toISOString() })); await rename(tmpReceipt, receipt);
        ownedReceipt = true;
        await this.sdk.publishPackage(candidate); committed = true;
        return { status: 'active', analytics: 'verified', gameId: id };
      } catch (error) {
        if (!committed) {
          if (ownedReceipt) await rm(receipt, { force: true });
          if (ownedProfile) await rm(target, { force: true });
          if (ownedDirectory) await rm(directory, { recursive: true, force: true });
          if (ownedProfile) {
            try {
              await this.activator.verify(this.recoveryProfile);
            } catch { throw importError('ANALYTICS_RECOVERY_PENDING', 'Instalación cancelada; el analizador todavía no confirmó su recuperación.', 503); }
          }
        }
        throw error;
      } finally {
        if (temporary) await rm(temporary, { force: true });
        await rm(transaction + '.tmp', { force: true });
        if (ownedTransaction) { await rm(transaction, { force: true }); await rm(receipt + '.tmp', { force: true }); }
        await rm(stage, { recursive: true, force: true });
      }
    });
  }
}
