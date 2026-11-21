class Base {
  value: string;
  constructor(value: string) { this.value = value; }
  brand() { return this.value; }
}
class Child extends Base {}
class Grandchild extends Child {}
class Override extends Base { brand() { return 'override:' + this.value; } }
class OverrideChild extends Override {}
class Sibling extends Base {}
class Other {
  value: string;
  constructor(value: string) { this.value = value; }
  brand() { return 'other:' + this.value; }
}

const a = new Base('a');
const b = new Base('b');
const c = new Child('c');
const d = new Grandchild('d');
const e = new Override('e');
const f = new OverrideChild('f');
const g = new Sibling('g');
const h = new Other('h');
// Demand each native implementation before reading it through an erased view.
console.log('calls', a.brand(), b.brand(), c.brand(), d.brand(), e.brand(), f.brand(), g.brand(), h.brand());
const instances: any[] = [a, b, c, d, e, f, g, h];
function method(value: any) { return value.brand; }
for (let i = 0; i < instances.length; i++) {
  for (let j = 0; j < instances.length; j++) {
    console.log(i, j, method(instances[i]) === method(instances[j]));
  }
}
const inherited = method(a);
const overridden = method(e);
console.log('borrow', inherited.call(c), inherited.call(d), overridden.call(f));
