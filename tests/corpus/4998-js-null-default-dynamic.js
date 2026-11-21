// @ts-nocheck
class Emitter {
  constructor() {
    this.events = { native: true };
    this.removeAll = (name = null) => {
      if (name !== null) {
        return delete this.events[name];
      }
      this.events = {};
      return false;
    };
  }
}

const emitter = new Emitter();
console.log(`${emitter.removeAll("native")}|${emitter.removeAll()}`);
