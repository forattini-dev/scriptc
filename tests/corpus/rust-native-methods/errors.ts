// @rust-only
// @no-engine
export {};
class Fault extends Error {
  explain(): string { return `${this.name}:${this.message}`; }
}
class Detailed extends Fault {
  explain(): string { return `detail:${super.explain()}`; }
}
const fault: Fault = new Detailed("broken");
console.log("error method", fault.explain(), fault.toString());
try { throw fault; } catch (caught) {
  if (caught instanceof Fault) console.log("caught method", caught.explain());
}
