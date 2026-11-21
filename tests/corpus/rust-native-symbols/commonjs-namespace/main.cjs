const Symbols = require("native-symbols-cjs");

class Example {
  get [Symbols.connected]() {
    return 7;
  }
}

const example = new Example();
console.log(example[Symbols.connected]);
