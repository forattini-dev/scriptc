'use strict';

/** @template T */
class Buffer {
  /** @type {Array<T|undefined>} */
  items = new Array(2).fill(undefined);

  /** @param {T} value */
  push(value) {
    this.items[0] = value;
  }

  /** @returns {T|undefined} */
  shift() {
    const value = this.items[0];
    this.items[0] = undefined;
    return value;
  }
}

const buffer = new Buffer();
buffer.push('a');
console.log(buffer.shift(), buffer.shift());
