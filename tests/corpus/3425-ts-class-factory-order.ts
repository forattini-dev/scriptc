const events: string[] = [];
class Base {
  value: number;
  constructor(value: number) { events.push("base"); this.value = value; }
  describe() { return `base:${this.value}`; }
}
function mark(label: string) { events.push(label); return label; }
function configured(config: { label: string }, unused: string) {
  return class extends Base {
    static snapshot = mark(`static:${config.label}`);
    captured = config;
    constructor(value: number) { super(value); events.push(`ctor:${config.label}`); }
    static label() { return config.label; }
    replace(label: string) { config = { label }; }
    describe() { return `${config.label}:${super.describe()}`; }
  };
}
const original = { label: "first" };
let input = original;
function argument() { events.push("argument"); return input; }
const First = configured(argument(), mark("unused:first"));
input = { label: "second" };
const Second = configured(argument(), mark("unused:second"));
const first = new First(7);
const twin = new First(8);
const second = new Second(9);
console.log(first.describe(), second.describe());
console.log(first.captured === original, twin.captured === first.captured, second.captured === input);
console.log(First === Second, first instanceof First, first instanceof Second, first instanceof Base);
original.label = "changed";
console.log(First.label(), First.snapshot, Second.label(), Second.snapshot);
first.replace("replaced");
console.log(first.describe(), twin.describe(), second.describe(), first.captured.label);
const base: Base = first;
console.log(base.describe());
console.log(events.join(","));
