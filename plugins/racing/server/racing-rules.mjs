/** Pure per-step physics, with the historical order: speed, advance, hits, finish line. */
export class RacingRules {
  initial(now) {
    return { lap: 0, totalLaps: 3, progress: 0, lapLength: 1200, speed: 0, lane: 1,
      collisions: 0, lapTimes: [], hit: [], lastTick: now, lapStarted: now, result: null,
      obstacles: [{ position: 240, lane: 1 }, { position: 510, lane: 0 },
        { position: 790, lane: 2 }, { position: 1040, lane: 1 }] };
  }
  validPayload(payload) {
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      && Object.keys(payload).length === 3 && ['lane', 'accelerate', 'brake'].every((k) => Object.hasOwn(payload, k))
      && Number.isInteger(payload.lane) && payload.lane >= 0 && payload.lane <= 2
      && typeof payload.accelerate === 'boolean' && typeof payload.brake === 'boolean';
  }
  step(state, { lane, accelerate, brake }, now) {
    const dt = Math.max(0, Math.min((now - state.lastTick) / 1000, 0.25));
    const speed = Math.max(0, Math.min(180, state.speed + (accelerate ? 65 : -18) * dt - (brake ? 140 * dt : 0)));
    const before = state.progress;
    const data = { ...state, lane, lastTick: now, speed, progress: before + speed * dt,
      lapTimes: [...state.lapTimes], hit: [...state.hit], obstacles: state.obstacles.map((o) => ({ ...o })) };
    const events = [];
    for (const [i, o] of data.obstacles.entries()) {
      if (!data.hit.includes(i) && o.lane === lane && before < o.position && data.progress >= o.position) {
        data.hit.push(i);
        data.speed *= 0.3; // Advance was already computed at the pre-impact speed, as in the historical game.
        data.collisions++;
        events.push({ type: 'OBSTACLE_HIT', playerId: 'human', data: { lap: data.lap + 1, lane } });
      }
    }
    if (data.progress >= data.lapLength) {
      const durationMs = Math.max(1, now - data.lapStarted);
      data.lap++;
      data.lapTimes.push(durationMs);
      events.push({ type: 'LAP_COMPLETED', playerId: 'human', data: { lap: data.lap, durationMs } });
      data.progress -= data.lapLength;
      data.lapStarted = now;
      data.hit = [];
      if (data.lap === data.totalLaps) data.result = 'race_completed';
    }
    return { data, events };
  }
}
