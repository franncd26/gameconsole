const directions = Object.freeze(Object.fromEntries(Object.entries({
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
}).map(([key, vector]) => [key, Object.freeze(vector)])));

/** Pure grid rules. Randomness and SDK coordination belong to the session. */
export class SnakeRules {
  initial(size) {
    const x = Math.floor(size * 0.3), y = Math.floor(size / 2);
    return { size, body: [{ x, y }, { x: x - 1, y }, { x: x - 2, y }],
      direction: 'right', food: null, points: 0, result: null };
  }
  validPayload(payload) {
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      && Object.keys(payload).length === 1 && Object.hasOwn(payload, 'direction')
      && typeof payload.direction === 'string' && Object.hasOwn(directions, payload.direction);
  }
  freeCells(size, body) {
    const free = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!body.some((p) => p.x === x && p.y === y)) free.push({ x, y });
    }
    return free;
  }
  tick(state, requested) {
    const old = directions[state.direction], next = directions[requested];
    const direction = old[0] + next[0] === 0 && old[1] + next[1] === 0 ? state.direction : requested;
    const [dx, dy] = directions[direction];
    const head = { x: state.body[0].x + dx, y: state.body[0].y + dy };
    const eating = state.food !== null && head.x === state.food.x && head.y === state.food.y;
    const collision = state.body.slice(0, eating ? state.body.length : -1).some((p) => p.x === head.x && p.y === head.y);
    const body = state.body.map((p) => ({ ...p }));
    const data = { ...state, body, food: state.food === null ? null : { ...state.food }, direction };
    if (head.x < 0 || head.y < 0 || head.x >= state.size || head.y >= state.size || collision) {
      return { data: { ...data, result: 'game_over' }, needsFood: false,
        events: [{ type: 'PLAYER_DIED', playerId: 'human', data: { cause: collision ? 'self_collision' : 'wall' } }] };
    }
    body.unshift(head);
    if (!eating) body.pop();
    return { data: { ...data, points: state.points + (eating ? 10 : 0) }, needsFood: eating,
      events: eating ? [{ type: 'APPLE_EATEN', playerId: 'human', data: { points: 10 } }] : [] };
  }
}
