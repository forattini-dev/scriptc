// @rust-only
// @no-engine
export {};
class Reader {
  stored = 3;
  async *[Symbol.asyncIterator]() { console.log("must stay deferred"); yield this.stored; }
  *[Symbol.iterator]() { console.log("must also stay deferred"); yield 2; }
  value(): number { return this.stored; }
}
const reader = new Reader();
console.log(reader.value());
