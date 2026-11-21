import { inspect } from './resource.mjs';
class Registry {
  states = new WeakMap<object, number>();
  constructor(key: object) { this.states.set(key, 42); }
}
const key = {};
console.log(inspect(key, () => new Registry(key)));
