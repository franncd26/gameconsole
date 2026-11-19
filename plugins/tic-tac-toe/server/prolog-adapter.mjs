import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GatoRules } from './gato-rules.mjs';

const program = fileURLToPath(new URL('../prolog/gato.pl', import.meta.url));
const algorithms = Object.freeze({ easy: 'reglas_basicas', medium: 'reglas_tacticas', hard: 'minimax' });

export class PrologFailure extends Error {
  constructor() { super('No se pudo obtener una decisión válida de Prolog.'); this.name = 'PrologFailure'; }
}

/** Owns only the subprocess boundary. request injection permits embedding/testing without SWI. */
export class PrologAdapter {
  #binary;
  #timeout;
  #request;
  constructor({ binary = process.env.SWIPL_PATH || 'swipl', timeoutMs = 8000, request } = {}) {
    if (typeof binary !== 'string' || !binary.trim() || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 60000 || (request !== undefined && typeof request !== 'function')) throw new PrologFailure();
    this.#binary = binary;
    this.#timeout = timeoutMs;
    this.#request = request ?? ((board, options) => this.#invoke(board, options));
  }
  async decide(input, { difficulty, signal } = {}) {
    if (!Object.hasOwn(algorithms, difficulty) || !Array.isArray(input) || input.length !== 9
      || input.some((v) => !['', 'X', 'O'].includes(v))) throw new PrologFailure();
    const board = Object.freeze([...input]), rules = new GatoRules();
    if (board.filter((v) => v === 'X').length !== board.filter((v) => v === 'O').length + 1
      || !board.includes('') || rules.winningLine(board, 'X').length || rules.winningLine(board, 'O').length
      || signal?.aborted) throw new PrologFailure();
    let decision;
    try { decision = await this.#request(board, { difficulty, signal }); }
    catch { throw new PrologFailure(); }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)
      || Object.keys(decision).length !== 3 || !['index', 'score', 'algorithm'].every((k) => Object.hasOwn(decision, k))
      || !Number.isInteger(decision.index) || decision.index < 0 || decision.index > 8 || board[decision.index] !== ''
      || decision.algorithm !== algorithms[difficulty]
      || (difficulty === 'hard' ? ![-10, 0, 10].includes(decision.score) : decision.score !== null)) throw new PrologFailure();
    return Object.freeze({ index: decision.index, score: decision.score, algorithm: decision.algorithm });
  }
  #invoke(board, { difficulty, signal }) {
    return new Promise((resolve, reject) => {
      let child, settled = false, size = 0;
      const chunks = [];
      const fail = () => {
        if (settled) return;
        settled = true;
        child?.kill();
        reject(new PrologFailure());
      };
      try {
        child = spawn(this.#binary, ['-q', '-s', program, '-g', 'main', '-t', 'halt'], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: this.#timeout, signal,
        });
      } catch { fail(); return; }
      child.on('error', fail);
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > 65536) return fail();
        chunks.push(chunk);
      });
      child.stderr.on('data', () => {}); // Drain without retaining or exposing private process diagnostics.
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return fail();
        try {
          const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          settled = true;
          resolve(result);
        } catch { fail(); }
      });
      child.stdin.on('error', fail);
      child.stdin.end(JSON.stringify({ board: board.map((v) => v || 'e'), player: 'O', difficulty }) + '\n');
    });
  }
}
