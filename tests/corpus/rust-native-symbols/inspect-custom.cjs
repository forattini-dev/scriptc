'use strict';
const util = require('node:util');

class Box {
  [util.inspect.custom]() { return 'box'; }
}

const box = new Box();
console.log(box[util.inspect.custom](), box instanceof Box);
