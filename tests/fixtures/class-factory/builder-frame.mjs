class Command {}
class Builder {
  constructor(config) { this.config = config; }
  build() {
    const closure = this;
    return class extends Command { read() { return closure.config; } };
  }
}
function command(config) { return new Builder(arguments[0]).build(); }
class Created extends command({ name: "first" }) {}
const created = new Created();
console.log(created.read());
