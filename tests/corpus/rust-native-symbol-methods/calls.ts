// @rust-only
// @no-engine
export {};
class Value {
  stored = 7;
  [Symbol.iterator](offset: number): number { return this.stored + offset; }
  [Symbol.asyncIterator](): string { return "async-key"; }
  iterator(): string { return "string-key"; }
  "Symbol.iterator"(): string { return "description-key"; }
}
const value = new Value();
console.log(value[Symbol.iterator](5), value[Symbol.asyncIterator]());
console.log(value.iterator());
