// @rust-only
// @no-engine
export {};
class Base {
  "#same" = 100;
  #same(): number { return 2; }
  base(): number { return this.#same(); }
  viaBase(other: Base): number { return other.#same(); }
}
class Child extends Base {
  #same(): number { return 20; }
  own(): number { return this.#same(); }
  [Symbol.iterator](): number { return this.#same(); }
}
const child = new Child();
console.log(child.base(), child.own(), child.viaBase(child), child[Symbol.iterator](), child["#same"]);
