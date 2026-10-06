// @no-engine
// Declared classes extending one evaluation of a class template: the
// heritage value is proven by type, evaluated once at the class statement.
const events: string[] = [];
class Root {
  input: number;
  constructor(input: number) { this.input = input; events.push("root:" + input); }
  static kind(): string { return "root"; }
  describe(): string { return "root:" + this.input; }
}

function make(tag: string) {
  events.push("make:" + tag);
  const prefix = "[" + tag + "]";
  const Made = class extends Root {
    static prefix(): string { return prefix; }
    describe(): string { return prefix + super.describe(); }
    tag(): string { return tag; }
  };
  return Made;
}

function current() { return Late; }

class First extends make("first") {
  extra: string;
  constructor(input: number, extra: string) {
    events.push("first:before-super");
    super(input * 10);
    this.extra = extra;
  }
  describe(): string { return "first(" + super.describe() + "," + this.extra + ")"; }
}
class Second extends make("second") {}
class Third extends First {
  describe(): string { return "third/" + super.describe(); }
}
const Late = make("late");
class FromBinding extends Late {}

const first = new First(1, "x");
const second = new Second(2);
const third = new Third(3, "y");
console.log(first.describe(), second.describe(), third.describe(), new FromBinding(4).describe());
console.log(First.prefix(), Second.prefix(), Third.prefix(), FromBinding.prefix(), First.kind(), Third.kind());
console.log(first.tag(), third.tag(), second.tag(), First.name, Third.name, FromBinding.name);
console.log(first instanceof First, first instanceof Second, third instanceof First, second instanceof Root);
console.log(new FromBinding(5) instanceof Late, first instanceof Late, current() === Late);
const Ctor: typeof Second = Second;
console.log(new Ctor(6).describe());
console.log(events.join(","));
