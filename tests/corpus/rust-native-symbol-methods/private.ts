// @rust-only
// @no-engine
export {};
class Reader {
  #stored = 3;
  async *[Symbol.asyncIterator]() { yield this.#stored; }
  [Symbol.iterator](): number { return this.#stored; }
  set(value: number): void { this.#stored = value; }
}
class Child extends Reader {
  [Symbol.iterator](): number { return super[Symbol.iterator]() + 10; }
}
const reader = new Reader();
const child = new Child();
console.log(reader[Symbol.iterator](), child[Symbol.iterator]());
reader.set(7);
child.set(8);
console.log(reader[Symbol.iterator](), child[Symbol.iterator]());
