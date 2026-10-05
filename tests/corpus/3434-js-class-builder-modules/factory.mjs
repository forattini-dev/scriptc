class Command {
  constructor(input) { this.input = input; }
}
class Builder {
  constructor(config) { this.config = config; }
  build() {
    const closure = this;
    let CommandRef;
    return (CommandRef = class extends Command {
      static configuration() { return closure.config; }
      read() { return closure.config.name + ":" + this.input; }
      command() { return CommandRef; }
    });
  }
}
export function command(config) { return new Builder(config).build(); }
