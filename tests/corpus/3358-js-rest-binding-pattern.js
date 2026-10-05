// @ts-nocheck -- JavaScript accepts missing and surplus constructor arguments.
let evaluations = 0;
function extra() { evaluations++; return "extra"; }
class Client {
  configuration;
  constructor(...[configuration]) { this.configuration = configuration; }
}
console.log(new Client("first", extra()).configuration, evaluations);
console.log(new Client().configuration === undefined);
function defaults(...[first = "fallback", second]) {
  console.log(first, second);
}
defaults();
defaults(undefined, "second", "third");
defaults("value", "tail");
function hole(...[, second]) { console.log(second); }
hole("ignored", "kept");
