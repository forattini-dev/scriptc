// @rust-only
// @no-engine
// @ts-nocheck
export {};
function mark(value: number): number { console.log("argument", value); return value; }
class Ordered {
  value = this.#double(mark(2));
  #double(value: number): number { console.log("body", value); return value * 2; }
  constructor(value = this.#double(mark(3))) { console.log("default", value, this.value); }
}
new Ordered();
class Base {
  constructor() { this.read(); }
  read(): number { return 0; }
}
class Child extends Base {
  #read(value: number): number { return value; }
  read(): number { return this.#read(mark(99)); }
}
try { new Child(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
class Early {
  #first = this.#read();
  #last = mark(88);
  #read(): number { return this.#last; }
}
try { new Early(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
