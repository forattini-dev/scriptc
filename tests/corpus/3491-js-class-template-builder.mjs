// @no-engine
// A builder method returns a class expression per call; the class captures
// the builder (`closure`) and its own value (`CommandRef`).
const events = [];
class Command {
  constructor(input) { events.push("base:" + input); this.input = input; }
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
      constructor(input) { super(input); events.push("command:" + closure.config.name); }
      command() { return CommandRef; }
      rename(name) { closure.config.name = name; }
    });
  }
}
function command(name) {
  return Command.classBuilder().ep({ name }).build();
}
const Get = command("get");
const Put = command("put");
const get = new Get(1);
const put = new Put(2);
console.log(Get === Put, Get.name, Get.configuration().name, Put.configuration().name);
console.log(get.command() === Get, get.command() === Put, new Get(3).command() === get.command());
console.log(get instanceof Get, get instanceof Put, put instanceof Command);
get.rename("renamed");
console.log(Get.configuration().name, Put.configuration().name);
const Again = command("get");
console.log(Again === Get, Again.configuration().name, new Again(4) instanceof Get);
console.log(events.join(","));
