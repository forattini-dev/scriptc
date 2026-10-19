// @rust-only
// @no-engine
const callbacks = new Set<() => number>();
const first = () => 1; const second = () => 1; const alias = first;
console.log("functions", callbacks.add(first) === callbacks, callbacks.has(alias), callbacks.has(second));
callbacks.add(second); callbacks.add(alias); console.log("distinct", callbacks.size, callbacks.delete(alias), callbacks.has(first));
function make(value: number): () => number { return () => value; }
const captured = make(7); const seeds = new Set([captured, captured, make(7)]);
console.log("seed functions", seeds.size, seeds.has(captured), seeds.has(make(7)));
function cycle(): boolean {
  const set = new Set<() => number>(); const read = () => set.size;
  set.add(read); console.log("function cycle", set.has(read), read()); return true;
}
cycle();
