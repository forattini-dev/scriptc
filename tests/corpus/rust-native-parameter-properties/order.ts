// @rust-only
// @no-engine
// @transform-types
let count = 0;
function mark(label: string): number { count = count + 1; console.log("mark", label, count); return count; }
class Base {
  field = mark("base field");
  constructor(public value = mark("base default")) {
    console.log("base body", this.field, this.value, value);
  }
}
class Child extends Base {
  field2 = mark("child field");
  // @ts-expect-error Field initialization precedes parameter-property assignment.
  observed: number | undefined = this.extra;
  constructor(public extra = mark("child default")) {
    extra = extra + 10;
    console.log("pre super", extra);
    super();
    console.log("child body", this.extra, this.observed === undefined);
  }
}
console.log("definitions", count);
const base = new Base();
const child = new Child();
console.log("results", base.value, child.value, child.extra, child instanceof Base);
class Override extends Base {
  constructor(public override value = mark("override default")) {
    super(99);
    console.log("override", this.value, value);
  }
}
new Override();
class Implicit extends Child {}
const implicit = new Implicit(23);
console.log("implicit", implicit.extra, implicit.observed === undefined);
class Forward {
  // @ts-expect-error The earlier field observes the later field before initialization.
  first: number | undefined = this.second;
  second = 42;
}
const forward = new Forward();
console.log("forward", forward.first === undefined, forward.second);
