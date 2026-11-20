import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export async function profilesDigest(directory) {
  const hash = createHash('sha256');
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.json')).sort()) {
    hash.update(createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex') + '  ' + name + '\n');
  }
  return hash.digest('hex');
}
export function importError(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
export function checkProfile(profile, gameId) {
  if (!profile || profile.profileSchemaVersion !== 1 || profile.gameId !== gameId
    || !Array.isArray(profile.capabilities) || !Array.isArray(profile.specializedAnalyzers)
    || !/^\d+\.\d+\.\d+$/.test(profile.profileVersion)) throw importError('INVALID_PROFILE', 'Perfil incompatible con el manifiesto.');
  const metrics = profile.capabilities.flatMap(c => c.templateId === 'event-metrics/v1' ? c.metrics || []
    : c.templateId === 'duration/v1' ? [{ id: c.parameters?.id }] : []);
  if (!metrics.some(m => typeof m.id === 'string')) throw importError('INVALID_PROFILE', 'Se requiere al menos una métrica declarativa event-metrics/v1 o duration/v1 verificable.');
  return profile;
}
function put(data, pointer, value) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/data/')) throw importError('INVALID_PROFILE', 'Ruta de datos analíticos inválida.');
  const keys = pointer.slice(6).split('/').map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (keys.length > 16 || keys.some(k => !k || ['__proto__','constructor','prototype'].includes(k))) throw importError('INVALID_PROFILE', 'Ruta de datos analíticos inválida.');
  let target = data; for (const k of keys.slice(0, -1)) target = target[k] ||= {};
  target[keys.at(-1)] = value;
}
export function analysisProbe(profile) {
  const matchId = randomUUID(), gameId = profile.gameId, start = { players: ['probe'] }, finish = {};
  if (profile.playersField) put(start, profile.playersField, ['probe']);
  const events = [], expected = [];
  const add = (type, data = {}) => events.push({ schemaVersion: 1, eventId: randomUUID(), timestamp: new Date(1700000000000 + events.length * 1000).toISOString(), gameId, matchId, type, data, playerId: 'probe' });
  add('MATCH_STARTED', start);
  for (const cap of profile.capabilities) {
    if (cap.templateId === 'event-metrics/v1') for (const metric of cap.metrics || []) {
      expected.push({ id: metric.id, instanceId: cap.instanceId, templateId: cap.templateId });
      if (!['MATCH_STARTED', 'MATCH_FINISHED'].includes(metric.eventType)) {
        const data = {}; if (metric.operation !== 'count') put(data, metric.field, Math.max(1, Math.ceil(metric.minimum || 0)));
        add(metric.eventType, data);
      } else if (metric.operation !== 'count') put(metric.eventType === 'MATCH_STARTED' ? start : finish, metric.field, Math.max(1, Math.ceil(metric.minimum || 0)));
    }
    if (cap.templateId === 'duration/v1') {
      expected.push({ id: cap.parameters.id, instanceId: cap.instanceId, templateId: cap.templateId });
      if (cap.parameters.endEventType !== 'MATCH_FINISHED') add(cap.parameters.endEventType);
    }
  }
  add('MATCH_FINISHED', finish);
  if (events.length > 10000 || Buffer.byteLength(JSON.stringify(events)) > 7 * 1024 * 1024) throw importError('INVALID_PROFILE', 'La prueba declarativa supera los límites del analizador.');
  return { snapshot: { gameId, matchId, state: 'closed', events }, expected };
}
export class ScalaActivator {
  constructor(url, { fetcher = fetch, timeoutMs = 60000, intervalMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)), profilesDirectory, stateDirectory } = {}) {
    let parsed; try { parsed = new URL(url); } catch {}
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw importError('IMPORT_CONFIGURATION', 'Configura el origen del analizador Scala.', 503);
    Object.assign(this, { url: parsed.origin, fetcher, timeoutMs, intervalMs, sleep, profilesDirectory, stateDirectory });
  }
  async verify(profile) {
    const { snapshot, expected } = analysisProbe(profile), end = Date.now() + this.timeoutMs;
    const digest = this.profilesDirectory ? await profilesDigest(this.profilesDirectory) : undefined;
    const acknowledged = async () => !digest || (await readFile(path.join(this.stateDirectory, 'loaded'), 'utf8')).trim() === digest;
    do {
      try {
        if (!await acknowledged()) throw Error();
        const r = await this.fetcher(this.url + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot), signal: AbortSignal.timeout(Math.min(4000, this.timeoutMs)), redirect: 'error' });
        const text = await r.text(); if (text.length > 8 * 1024 * 1024) throw Error();
        const value = JSON.parse(text);
        if (r.ok && value.gameId === snapshot.gameId && value.matchId === snapshot.matchId && value.state === 'closed'
          && value.metrics?.some(m => expected.some(e => e.id === m.id && e.instanceId === m.source?.instanceId && e.templateId === m.source?.templateId)
            && m.source.profileVersion === profile.profileVersion && m.basis?.eventCount === snapshot.events.length
            && m.status === 'final' && m.value !== null && m.value !== undefined) && await acknowledged()) return;
      } catch { /* Startup/restart is transient. No fake success from health or empty results. */ }
      if (Date.now() >= end) break;
      await this.sleep(this.intervalMs);
    } while (Date.now() < end);
    throw importError('ANALYTICS_ACTIVATION_FAILED', 'Scala no confirmó una métrica del perfil; se cancela la activación.', 503);
  }
}
