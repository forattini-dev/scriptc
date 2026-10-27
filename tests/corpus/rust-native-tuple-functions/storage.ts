// @rust-only
// @no-engine
export {};
function make(seed: number) {
  let value = seed;
  return [(delta: number): number => value += delta, (): number => value] as const;
}
const first = make(1);
const second = make(10);
const add = first[0];
console.log("escape", add(2), first[1](), second[1]());
console.log("fresh", first !== second, first[0] !== second[0]);
function erased(value: any): number {
  const [increment, read] = value;
  increment(4);
  return Number(read());
}
console.log("erased", erased(first), first[1](), second[1]());
const rows = [first, second];
for (const [increment, read] of rows) console.log("array", increment(1), read());
type Row = readonly [() => number, number];
function cycle(): number {
  let row: Row | undefined;
  row = [(): number => row === undefined ? 0 : row[1], 9] as const;
  return row[0]();
}
console.log("cycle", cycle());
