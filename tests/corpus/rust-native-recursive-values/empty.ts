interface Cell {
  child?: Cell;
  empty: {};
}
const empty = {};
const cell: Cell = { empty };
cell.child = cell;
console.log(cell.empty === empty);
console.log(cell.child === cell);
