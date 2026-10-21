// @rust-only
// @no-engine
export {};
class Deferred {
  #unused(): number { while (true) {} }
  *#generator() { yield 1; }
  async *#asyncGenerator() { yield 2; }
  value = 9;
}
console.log(new Deferred().value);
