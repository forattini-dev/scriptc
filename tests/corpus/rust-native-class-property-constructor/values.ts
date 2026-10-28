// @rust-only
// @no-engine
export {};
class Group {
  value: number;
  constructor(value: number) { this.value = value; }
}
const registry = { Group };
let calls = 0;
function getRegistry(): { Group: typeof Group } { calls++; return registry; }
function argument(): number { calls++; return calls; }
const first = new (getRegistry().Group)(argument());
function make(source: { Group: typeof Group }, value: number): Group {
  return new source.Group(value);
}
const second = make(registry, 7);
console.log(first.value, second.value, calls, first === second);
