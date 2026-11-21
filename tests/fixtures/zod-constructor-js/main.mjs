class Base {
  constructor(def) { this._def = def; }
  describe(description) { const This = this.constructor; return new This({ ...this._def, description }); }
}
class Child extends Base {}
const one = new Child({ x: 1 });
const two = one.describe('new');
console.log(two instanceof Child, two._def.x, two._def.description, two !== one);
