'use strict';

class Events {
  /** @param {Limiter} instance */
  constructor(instance) {
    this.instance = instance;
    /**
     * @param {string} name
     * @param {(value: string) => string} callback
     */
    this.instance.on = (name, callback) => callback(name);
  }
}

class Limiter {
  constructor() {
    new Events(this);
  }
}

module.exports = Limiter;
