'use strict';
const { kLocal, kRegistry } = require('./exported-symbols.cjs');

class Box {
  [kLocal] = 17;
  [kRegistry] = 23;
  local() { return this[kLocal]; }
}

const box = new Box();
console.log(box[kLocal], box[kRegistry], box.local());
