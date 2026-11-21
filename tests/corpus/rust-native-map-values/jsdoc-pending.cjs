'use strict';

class Pending {
  constructor() {
    /** @type {Map<number|string, { resolve: Function }>} */
    this.values = new Map();
  }

  close() {
    for (const { resolve } of this.values.values()) {
      resolve(41);
    }
    this.values.clear();
  }
}

const pending = new Pending();
pending.values.set(1, { resolve: /** @param {number} value */ (value) => console.log(value + 1) });
pending.close();
