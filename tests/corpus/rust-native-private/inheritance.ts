// @rust-only
// @no-engine
export {};
class Base {
  #value = 1;
  get base(): number { return this.#value; }
  set base(value: number) { this.#value = value; }
}
class Child extends Base {
  #value = this.base + 1;
  get own(): number { return this.#value; }
  set own(value: number) { this.#value = value; }
}
const child = new Child();
const base: Base = child;
console.log("initial", base.base, child.own);
base.base = 8;
child.own = 12;
console.log("distinct", base.base, child.own);
class Caller {
  constructor() { console.log("during base", this.read()); }
  read(): number { return 0; }
}
class NotInstalled extends Caller {
  #value = 3;
  read(): number { return this.#value; }
}
try { new NotInstalled(); } catch (error) { if (error instanceof TypeError) console.log("early derived", error.message); }
