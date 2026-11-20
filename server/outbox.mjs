import { copyJSON, freezeJSON, isObject, requireSDK, SDKError } from './sdk/values.mjs';

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || match[0] !== value || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1
    && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function prepareBatch(events) {
  const check = (condition, message) => requireSDK(condition, 'INVALID_EVENT_BATCH', message);
  check(Array.isArray(events) && events.length >= 1 && events.length <= 32,
    'El lote requiere entre 1 y 32 eventos.');
  const members = Object.getOwnPropertyDescriptors(events);
  check(Reflect.ownKeys(members).length === events.length + 1, 'El lote debe ser un arreglo JSON denso sin propiedades adicionales.');
  const batch = [];
  for (let index = 0; index < events.length; index++) {
    const member = members[index];
    check(member?.enumerable && Object.hasOwn(member, 'value') && isObject(member.value), `events[${index}]: se requiere objeto JSON.`);
    const fields = Object.getOwnPropertyDescriptors(member.value);
    const keys = Reflect.ownKeys(fields);
    check(keys.every((key) => typeof key === 'string' && fields[key].enumerable && Object.hasOwn(fields[key], 'value')),
      `events[${index}]: no se admiten accesores, símbolos ni campos ocultos.`);
    // Validate JSON per field, keeping the existing 64-level budget for data rather than batch/envelope wrappers.
    const event = Object.fromEntries(keys.map((key) => [key, copyJSON(fields[key].value, 'INVALID_EVENT_BATCH')]));
    check(event.schemaVersion === 1 && ['eventId', 'timestamp', 'gameId', 'matchId', 'type', 'data'].every((key) => Object.hasOwn(event, key)),
      `events[${index}]: faltan campos del sobre v1 o schemaVersion es incompatible.`);
    check(['eventId', 'gameId', 'matchId', 'type'].every((key) => typeof event[key] === 'string' && event[key].trim().length > 0)
      && validTimestamp(event.timestamp) && isObject(event.data)
      && ['gameVersion', 'playerId'].every((key) => !Object.hasOwn(event, key) || typeof event[key] === 'string'),
    `events[${index}]: identidad, timestamp RFC3339 o data inválidos.`);
    check(Buffer.byteLength(JSON.stringify(event), 'utf8') <= 1024 * 1024,
      `events[${index}]: el sobre supera 1 MiB.`);
    check(index === 0 || (event.gameId === batch[0].gameId && event.matchId === batch[0].matchId),
      'Todos los eventos del lote deben pertenecer al mismo gameId y matchId.');
    check(!batch.some((previous) => previous.eventId === event.eventId), 'El lote contiene eventId duplicados.');
    batch.push(freezeJSON(event));
  }
  return batch;
}

export class EventOutbox {
  constructor(base, { fetcher = fetch, retryMs = 600 } = {}) {
    this.base = base.replace(/\/$/, "");
    this.fetch = fetcher;
    this.retryMs = retryMs;
    this.streams = new Map();
    this.stopped = false;
  }
  enqueue(event) {
    const key = event.matchId;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { queue: [], running: false, error: null, delivered: 0 };
      this.streams.set(key, stream);
    }
    stream.queue.push(event);
    this.pump(key, stream);
  }
  enqueueBatch(events) {
    requireSDK(!this.stopped, 'OUTBOX_STOPPED', 'El Outbox detenido no acepta lotes.');
    let batch;
    try { batch = prepareBatch(events); }
    catch (error) {
      if (error instanceof SDKError && error.code === 'INVALID_EVENT_BATCH') throw error;
      throw new SDKError('INVALID_EVENT_BATCH', 'No se pudo validar el lote JSON.');
    }
    const key = batch[0].matchId;
    const current = this.streams.get(key);
    const queue = current ? [...current.queue, ...batch] : batch;
    const stream = current ?? { queue, running: false, error: null, delivered: 0 };
    // Exactly one synchronous publication; pump cannot inspect a partially inserted batch.
    if (current) current.queue = queue;
    else this.streams.set(key, stream);
    this.pump(key, stream);
  }
  async pump(key, s) {
    if (s.running || this.stopped) return;
    s.running = true;
    let attempts = 0;
    while (s.queue.length && !this.stopped) {
      const e = s.queue[0];
      try {
        const r = await this.fetch(`${this.base}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(e),
          signal: AbortSignal.timeout(5000),
        });
        if (r.status === 409) {
          const check = await this.fetch(
            `${this.base}/matches/${encodeURIComponent(e.gameId)}/${encodeURIComponent(e.matchId)}`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!check.ok || !(await check.json()).eventIds?.includes(e.eventId))
            throw new Error("Conflicto de ciclo de vida en GameStats.");
        } else if (!r.ok) throw new Error(`GameStats respondió ${r.status}.`);
        s.queue.shift();
        s.delivered++;
        s.error = null;
        attempts = 0;
      } catch (error) {
        s.error = error.message;
        attempts++;
        await new Promise((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(this.retryMs * 2 ** Math.min(attempts - 1, 4), 10000),
          );
          timer.unref?.();
        });
      }
    }
    s.running = false;
  }
  status(id) {
    const s = this.streams.get(id);
    return s
      ? { pending: s.queue.length, delivered: s.delivered, error: s.error }
      : { pending: 0, delivered: 0, error: null };
  }
  async flush(timeout = 12000) {
    const end = Date.now() + timeout;
    while ([...this.streams.values()].some((s) => s.queue.length)) {
      if (Date.now() > end) throw new Error("Hay eventos pendientes de envío.");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  stop() {
    this.stopped = true;
  }
}
