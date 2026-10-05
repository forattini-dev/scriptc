class Command {}
class Builder {
  constructor(config) { this.config = config; }
  build() {
    const closure = this;
    return class extends Command { read() { return closure.config; } };
  }
}
function command(config) { return new Builder(config).build(); }
function repeat(config) { return command(config); }
console.log(repeat({ name: "first" }) === repeat({ name: "second" }));
