// @rust-only
// @no-engine
export {};
class Counter {
  value = 0;
  add(step = 1): number { this.value = this.value + step; return this.value; }
  reset(): void { this.value = 0; }
  reader(): () => number { const self: Counter = this; return () => self.value; }
  factorial(n: number): number { if (n === 0) return 1; return n * this.factorial(n - 1); }
}
const counter = new Counter();
function receiver(): Counter { console.log("receiver"); return counter; }
function argument(): number { console.log("argument"); return 3; }
console.log("direct", counter.add(), counter.add(2), counter.add(undefined));
console.log("ordered", receiver().add(argument()), counter.value);
counter.reset();
console.log("reset", counter.value, counter.factorial(5));
const alias = counter;
console.log("alias", alias.add(7), counter.value, alias === counter);
const read = counter.reader();
counter.add();
console.log("captured alias", read());
