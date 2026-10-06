// @no-engine
// Class expressions evaluated inside functions: each evaluation is a distinct
// class with its own captured environment over one shared shape.
class Shape {
  size: number;
  constructor(size: number) { this.size = size; }
  area(): number { return this.size * this.size; }
  describe(): string { return "shape:" + this.area(); }
}

function make(tag: string, scale: number) {
  const prefix = "<" + tag + ">";
  return class extends Shape {
    static tagOf(): string { return prefix; }
    static scaled(size: number): number { return size * scale; }
    label = prefix + this.size;
    area(): number { return super.area() * scale; }
    describe(): string { return prefix + super.describe(); }
    later(): () => string { return () => prefix + ":" + this.size * scale; }
  };
}

function named(word: string) {
  const Named = class {
    word(): string { return word; }
  };
  return Named;
}

function run(): void {
  const A = make("a", 2);
  const B = make("b", 3);
  console.log(A === B, A === A, make("a", 2) === make("a", 2));
  console.log(JSON.stringify(A.name), named("x").name, A.tagOf(), B.tagOf(), A.scaled(5), B.scaled(5));
  const a = new A(3);
  const b = new B(3);
  console.log(a.area(), b.area(), a.describe(), b.describe(), a.label, b.label);
  console.log(a instanceof A, a instanceof B, b instanceof B, a instanceof Shape);
  const callback = a.later();
  console.log(callback(), new B(1).later()());
  let Current = A;
  console.log(new Current(1).describe());
  Current = B;
  console.log(new Current(1).describe(), Current === B, Current === A);
  const all = [make("x", 1), make("y", 1)];
  console.log(all.map((C) => new C(2).describe()).join(","), all[0] === all[1]);
  console.log(new (named("hello"))().word(), named("w") === named("w"));
}

run();
for (let i = 1; i <= 2; i++) {
  const C = make("loop" + i, i);
  console.log(C.tagOf(), new C(i).area(), new C(1) instanceof C);
}
