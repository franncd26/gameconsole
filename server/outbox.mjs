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
