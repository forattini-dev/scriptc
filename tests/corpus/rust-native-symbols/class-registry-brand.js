const kBase = Symbol.for('scriptc.brand.base');
class Base extends Error {
  constructor(message) { super(message); }
  static [Symbol.hasInstance](instance) {
    return instance && instance[kBase] === true;
  }
  get [kBase]() { return true; }
}

const kChild = Symbol.for('scriptc.brand.child');
class Child extends Base {
  constructor(message) { super(message); }
  static [Symbol.hasInstance](instance) {
    return instance && instance[kChild] === true;
  }
  get [kChild]() { return true; }
}

const base = new Base('base');
const child = new Child('child');
console.log(base instanceof Base, child instanceof Base, base instanceof Child, child instanceof Child);
console.log(({ [kChild]: true }) instanceof Child, ({ [kChild]: false }) instanceof Child);
