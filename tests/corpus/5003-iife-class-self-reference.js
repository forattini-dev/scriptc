// @ts-nocheck
var Bottleneck;

Bottleneck = (function () {
  class Bottleneck {
    constructor() {
      this.value = Bottleneck.prototype.answer;
    }
  }
  return Bottleneck;
}).call(this);

Bottleneck.prototype.answer = 42;

console.log(new Bottleneck().value === 42);
