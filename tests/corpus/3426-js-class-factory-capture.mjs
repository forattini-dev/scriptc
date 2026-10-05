const events = [];
class Base {
  constructor(value) { this.value = value; events.push("base"); }
  describe() { return `base:${this.value}`; }
}
const configured = (config, label) => class extends Base {
  constructor(value) { super(value); this.label = label; }
  describe() { return `${config.region}:${this.label}:${super.describe()}`; }
  static region() { return config.region; }
};
const config = { region: "local" };
class First extends configured(config, "first") {}
class Second extends configured({ region: "other" }, "second") {}
const first = new First(7);
console.log(first.describe(), new Second(9).describe());
config.region = "changed";
console.log(First.region(), first.describe());
console.log(first instanceof First, first instanceof Second, first instanceof Base);
console.log(events.join(","));
