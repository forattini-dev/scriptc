// @rust-only
// @no-engine
export {};
class Counter {
  count = 1;
  [Symbol.iterator](value: number): void { this.count = this.count + value; console.log("body", this.count); }
}
const counter = new Counter();
function receiver(): Counter { console.log("receiver"); return counter; }
function argument(): number { console.log("argument"); return 4; }
receiver()[Symbol.iterator](argument());
console.log(counter.count);
