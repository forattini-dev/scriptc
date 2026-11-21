'use strict';

const { Base, key } = require('./shorthand-export.cjs');

class Child extends Base {
  [key]() { return 17; }
}

console.log(new Child()[key]());
