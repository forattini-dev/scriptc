// @no-engine
class Command {
  constructor(input) { this.input = input; }
  static classBuilder() { return new Builder(); }
}
class Builder {
  config = {};
  ep(config) { this.config = config; return this; }
  build() {
    const closure = this;
    let CommandRef;
    return (CommandRef = class extends Command {
      static configuration() { return closure.config; }
      command() { return CommandRef; }
    });
  }
}
function makeBuilder(common) {
  return function command(added) {
    const merged = Object.assign({}, common, added);
    return Command.classBuilder().ep(merged).build();
  };
}
const command = makeBuilder({ region: "common" });
class First extends command({ name: "first" }) {}
class Second extends command({ name: "second" }) {}
const first = new First(7);
console.log(First.configuration().region, First.configuration().name, Second.configuration().name, first.input);
console.log(first.command() === new First(8).command(), first.command() === new Second(9).command());
