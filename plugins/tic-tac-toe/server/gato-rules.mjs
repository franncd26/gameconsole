const lines = Object.freeze([
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6],
].map(Object.freeze));

/** Pure rules: no lifecycle, transport or alternative mutable board. */
export class GatoRules {
  winningLine(board, symbol) {
    return [...(lines.find((line) => line.every((i) => board[i] === symbol)) ?? [])];
  }
  canPlace(state, index, symbol) {
    return state.result === null && Number.isInteger(index) && index >= 0 && index < 9
      && state.board[index] === '' && (symbol === 'X'
        ? state.turn % 2 === 0 && !state.awaitingAI
        : symbol === 'O' && state.turn % 2 === 1 && state.awaitingAI);
  }
  place(state, index, symbol) {
    if (!this.canPlace(state, index, symbol)) throw new Error('Movimiento de Gato inválido.');
    const board = [...state.board];
    board[index] = symbol;
    const turn = state.turn + 1;
    const winningLine = this.winningLine(board, symbol);
    const result = winningLine.length ? symbol === 'X' ? 'human_won' : 'prolog_won' : turn === 9 ? 'draw' : null;
    return { ...state, board, turn, winningLine, result, awaitingAI: symbol === 'X' && result === null };
  }
}
