// @rust-only
// @no-engine
let count = 0;
function mark(label: string): number { count = count + 1; console.log("mark", label, count); return count; }
class Base {
  value: number | undefined = mark("base field");
  constructor(value = mark("base default")) {
    console.log("base body", this.value === undefined, value);
    this.value = value;
  }
}
class Child extends Base {
  extra = mark("child field");
  constructor(value = mark("child default")) {
    console.log("before super");
    super(value);
    console.log("child body", this.value === undefined, this.extra);
  }
}
console.log("defined", count);
const base = new Base();
const child = new Child();
class Implicit extends Base { extra = mark("implicit field"); }
const implicit = new Implicit();
class Reset extends Base { value: number | undefined = undefined; }
const reset = new Reset(19);
console.log("results", base.value === 2, child.value === 3, child.extra, implicit.value === 7, reset.value === undefined);
const parent: Base = child;
console.log("inheritance", parent === child, parent instanceof Base, parent instanceof Child, base instanceof Child);
if (parent instanceof Child) console.log("narrowed", parent.extra);
class ParameterThis {
  field = mark("this field");
  constructor(value = this.field) { console.log("this default", value === this.field); }
}
new ParameterThis();
