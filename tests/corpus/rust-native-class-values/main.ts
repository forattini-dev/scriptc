// @rust-only
// @no-engine
class Fault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fault";
  }
}
const Alias = Fault;
const fault = new Alias("alias");
console.log("alias", fault.name, fault.message, fault instanceof Fault, Alias === Fault);
const Constructor = class extends Error {};
const expression = new Constructor("expression");
console.log("expression", expression.message, expression instanceof Error);
var Hoisted = class extends Error {};
const hoisted = new Hoisted("hoisted");
console.log("hoisted", hoisted.message, hoisted instanceof Error);
