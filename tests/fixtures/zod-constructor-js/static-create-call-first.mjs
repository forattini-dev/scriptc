class Base {}
class Pipeline extends Base {
  constructor(def) { super(); this.def = def; }
  static create(a, b) { return new Pipeline({ a, b }); }
  static create$extracted(value) { return value * 10; }
}
const direct = Pipeline.create(1, 2);
const extracted = Pipeline.create;
const indirect = extracted(3, 4);
console.log(direct.def.a, direct.def.b, indirect.def.a, indirect.def.b, Pipeline.create$extracted(7));
