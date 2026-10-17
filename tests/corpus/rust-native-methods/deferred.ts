// @rust-only
// @no-engine
export {};
class Deferred {
  value = 42;
  unused(): number { while (true) {} }
  async asynchronous(): Promise<number> { return 1; }
  *generator(): Generator<number> { yield 2; }
}
console.log("defined");
const deferred = new Deferred();
console.log("unused bodies", deferred.value);
