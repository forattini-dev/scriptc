// @rust-only
// @no-engine
function factory(start: number): (step: number) => Promise<number> {
  let value = start;
  return async (step: number): Promise<number> => { value = value + step; console.log("increment", value); return value; };
}
const increment = factory(10);
const alias = increment;
const a = alias(1);
const b = increment(2);
console.log("same", alias === increment);
a.then(value => { console.log("a", value); });
b.then(value => { console.log("b", value); });
const square = async (value: number): Promise<number> => value * value;
square(5).then(value => { console.log("square", value); });
class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
  async next(): Promise<number> { this.value = this.value + 1; console.log("method", this.value); return this.value; }
}
const counter = new Counter(20);
counter.next().then(value => { console.log("next", value); });
console.log("after", counter.value);
