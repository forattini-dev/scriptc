'use strict';

class Limiter {
  /** @param {number} value */
  constructor(value) {
    this.value = value;
  }

  read() {
    return this.value;
  }
}

module.exports = Limiter;
