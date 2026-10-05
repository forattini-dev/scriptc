class Command {}
function command(config) { return new Builder(config).build(); }
const Created = command({ name: "early" });
class Builder {
  constructor(config) { this.config = config; }
  build() {
    const closure = this;
    return class extends Command { read() { return closure.config; } };
  }
}
console.log(new Created().read());
