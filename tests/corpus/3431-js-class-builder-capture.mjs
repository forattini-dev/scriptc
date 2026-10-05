class Command {
  constructor(input) { this.input = input; }
}
class ClassBuilder {
  constructor(config) { this.config = config; }
  build() {
    const closure = this;
    let CommandRef;
    return (CommandRef = class extends Command {
      static configuration() { return closure.config; }
      static identity() { return CommandRef; }
      constructor(input) { super(input); this.config = closure.config; }
      command() { return CommandRef; }
    });
  }
}
function command(config) { return new ClassBuilder(config).build(); }
class First extends command({ name: "first" }) {}
class Second extends command({ name: "second" }) {}
const first = new First(7);
console.log(First.configuration().name, Second.configuration().name, first.input);
console.log(first.config === First.configuration(), first.command() === new First(8).command());
console.log(first.command() === new Second(9).command(), first instanceof First, first instanceof Second);
console.log(first.command().name, first.command() === First);
console.log(First.identity() === first.command(), First.identity() === Second.identity());
