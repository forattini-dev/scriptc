/** @param {{ cellIndex: number }} state @param {number} length */
function advance(state, length) {
  const assigned = state.cellIndex += length;
  return `${assigned}:${state.cellIndex}`;
}

console.log(advance({ cellIndex: 1 }, 2));
