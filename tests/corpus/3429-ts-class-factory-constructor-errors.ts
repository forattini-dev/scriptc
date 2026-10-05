const events: string[] = [];
class Base {
  value: number;
  constructor(value: number) {
    events.push("base");
    if (value < 0) throw new RangeError("negative");
    this.value = value;
  }
}
function configured(label: string) {
  return class extends Base {
    own = label;
    constructor(value: number) { super(value); events.push(label); }
  };
}
class First extends configured("first") {}
try { new First(-1); } catch (error) {
  if (error instanceof RangeError) console.log(error.name, error.message);
}
const first = new First(7);
console.log(first.value, first.own, first instanceof Base);
console.log(events.join(","));
