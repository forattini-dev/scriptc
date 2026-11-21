'use strict';

const { key } = require('./shorthand-export.cjs');

class Child {
  [key]() { return 17; }
}

console.log(new Child()[key]());
