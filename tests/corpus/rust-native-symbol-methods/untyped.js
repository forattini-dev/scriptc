// @rust-only
// @no-engine
export {};
class Value {
  constructor() { this.stored = 8; }
  [Symbol.iterator]() { return this.stored; }
  [Symbol.asyncIterator]() { return "async"; }
}
const value = new Value();
console.log(value[Symbol.iterator](), value[Symbol.asyncIterator]());
class Replaced {
  [Symbol.iterator]() { return 1; }
  [Symbol.iterator]() { return 2; }
}
console.log(new Replaced()[Symbol.iterator]());
