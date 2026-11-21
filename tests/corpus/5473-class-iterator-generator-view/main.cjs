"use strict";

function createIterator() {
  class FastIterableIterator {
    constructor(values) {
      this.values = values;
      this.index = 0;
    }

    next() {
      if (this.index >= this.values.length) {
        return { value: undefined, done: true };
      }
      return { value: this.values[this.index++], done: false };
    }

    return(value) {
      this.index = this.values.length;
      return { value, done: true };
    }
  }

  /**
   * @param {any[]} values
   * @returns {IterableIterator<any>}
   */
  return function (values) {
    return new FastIterableIterator(values);
  };
}

const makeIterator = createIterator();
const iterator = makeIterator(["a", "b", "c"]);
const first = iterator.next();
const second = iterator.next();
const closed = iterator.return("stop");
const after = iterator.next();

console.log(`${first.done}:${first.value}`);
console.log(`${second.done}:${second.value}`);
console.log(`${closed.done}:${closed.value}`);
console.log(`${after.done}:${String(after.value)}`);

