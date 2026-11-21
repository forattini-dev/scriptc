// The erased method path currently accepts this program but rejects the plain
// receiver at runtime. Node calls the unbound prototype function with it.
export {};
class Base {
  value: string;
  constructor(value: string) { this.value = value; }
  brand() { return this.value; }
}
class Child extends Base {}
class Override extends Base { brand() { return 'override:' + this.value; } }
const a = new Base('a');
const b = new Child('b');
const c = new Override('c');
console.log('calls', a.brand(), b.brand(), c.brand());
function method(value: any) { return value.brand; }
const f = method(a);
const g = method(b);
const h = method(c);
console.log('identity', f === method(a), f === g, f === h, g === h);
console.log('call', f.call(a), f.call(b), h.call(c));
console.log('plain', f.call({value: 'borrowed'}));
