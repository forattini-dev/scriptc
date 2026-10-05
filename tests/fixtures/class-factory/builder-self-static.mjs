class Command {}
class Builder {
  constructor(config) { this.config = config; }
  build() {
    const closure = this;
    let CommandRef;
    return (CommandRef = class extends Command {
      static early = CommandRef;
      static configuration() { return closure.config; }
      command() { return CommandRef; }
    });
  }
}
function command(config) { return new Builder(config).build(); }
const Created = command({ name: "first" });
console.log(Created.early);
