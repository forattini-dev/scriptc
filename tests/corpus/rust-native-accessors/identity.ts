// @rust-only
// @no-engine
export {};
type Entry = { value: number };
class Cell {
  stored: Entry;
  constructor(initial: Entry) { this.stored = initial; }
  get value(): Entry { return this.stored; }
  set value(next: Entry) { next.value = next.value + 1; this.stored = next; }
}
const first = { value: 1 };
const second = { value: 7 };
const cell = new Cell(first);
const alias = cell;
console.log("before", cell.value === first, first.value);
const assigned = (alias.value = second);
console.log("identity", assigned === second, cell.value === assigned, alias === cell);
console.log("mutation", first.value, second.value, assigned.value);
assigned.value = 19;
console.log("shared", cell.value.value, second.value);
