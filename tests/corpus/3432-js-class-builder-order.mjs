const events = [];
class Command {
  constructor(input) { events.push("base:" + input); this.input = input; }
}
class Builder {
  constructor(config) { events.push("builder:" + config.name); this.config = config; }
  build() {
    const closure = this;
    let CommandRef;
    return (CommandRef = class extends Command {
      static configuration() { return closure.config; }
      static builder() { return closure; }
      constructor(input) { super(input); events.push("command:" + closure.config.name); }
      replace(config) { closure.config = config; }
      command() { events.push("self"); return CommandRef; }
    });
  }
}
const command = function(config, unused) { return new Builder(config).build(); };
const shared = { name: "first" };
function configuration() { events.push("argument:first"); return shared; }
function unused(label) { events.push("unused:" + label); return label; }
const First = command(configuration(), unused("first"));
const Second = command({ name: "second" }, unused("second"));
const first = new First(7);
const twin = new First(8);
const second = new Second(9);
console.log(First.configuration() === shared, First.builder() === Second.builder());
shared.name = "changed";
console.log(First.configuration().name, Second.configuration().name);
first.replace({ name: "replaced" });
console.log(First.configuration().name, Second.configuration().name);
console.log(first.command() === twin.command(), first.command() === second.command(), first.command().name);
console.log(events.join(","));
