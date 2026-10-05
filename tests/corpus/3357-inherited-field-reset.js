// @ts-nocheck -- bare redeclarations intentionally exercise JavaScript's runtime reset semantics.
class Base {
  /** @type {*} */
  config;
  constructor() {
    this.config = "base";
    console.log("base", this.config);
  }
}
class Derived extends Base {
  before = this.config;
  /** @type {*} */
  config;
  after = this.config;
  constructor() {
    super();
    console.log("fields", this.before, this.after);
    console.log("reset", this.config === undefined);
    this.config = "derived";
  }
}
const derived = new Derived();
console.log("final", derived.config);
class Reset extends Derived { /** @type {*} */ config; }
console.log("inherited-constructor", new Reset().config === undefined);

class OptionalBase {
  /** @type {number | undefined} */
  count = 7;
}
class OptionalDerived extends OptionalBase {
  /** @type {number | undefined} */
  count;
}
console.log("optional", new OptionalDerived().count === undefined);
