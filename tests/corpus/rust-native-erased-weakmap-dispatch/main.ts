import { inspect } from "./resource.js";

class Registry {
  states = new WeakMap<object, number>();
  constructor(key: object) {
    this.states.set(key, 42);
  }
}

const key = {};
console.log(JSON.stringify(inspect(key, () => new Registry(key))));
