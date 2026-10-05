const events: string[] = [];
function label(name: string) { events.push("static:" + name); return name; }
class Command {
  input: number;
  constructor(input: number) { this.input = input; }
}
class Builder {
  config: { name: string };
  constructor(config: { name: string }) { events.push("builder:" + config.name); this.config = config; }
  build() {
    const closure = this;
    return class extends Command {
      static readonly label = label(closure.config.name);
      static configuration() { return closure.config; }
      read() { return closure.config.name + ":" + this.input; }
    };
  }
}
const command = (config: { name: string }) => new Builder(config).build();
class First extends command({ name: "first" }) {}
class Second extends command({ name: "second" }) {}
const first = new First(7);
console.log(first.read(), new Second(9).read());
First.configuration().name = "changed";
console.log(first.read(), Second.configuration().name, first instanceof First, first instanceof Second);
console.log(First.label, Second.label, events.join(","));
