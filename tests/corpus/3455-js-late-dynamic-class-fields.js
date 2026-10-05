// @rust-only
// @no-engine
class Container {
  get value() { return this.payload; }
  set value(value) { this.payload = value; }
}
const first = new Container();
const alias = first;
const second = new Container();
console.log(first.value === undefined, second.value === undefined);
first.value = "assigned";
console.log(alias.value, second.value === undefined);
alias.value = 7;
console.log(first.value, first.value === 7);
first.value = { nested: true };
console.log(JSON.stringify(first.value));
first.value = undefined;
console.log(first.value === undefined);

class Conditional {
  constructor(enabled, value) {
    if (enabled) this.payload = value;
  }
  read() { return this.payload; }
}
const empty = new Conditional(false, 4);
const present = new Conditional(true, "present");
console.log(empty.read() === undefined);
console.log(present.read());
console.error("late dynamic class fields finished");
