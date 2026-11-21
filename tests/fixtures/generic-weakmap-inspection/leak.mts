import { passthrough } from './passthrough.mjs';
class Registry {
  states = new WeakMap<object, number>();
  constructor(key: object) { this.states.set(key, 42); }
}
const key = {};
const registry: any = passthrough(() => new Registry(key));
console.log(registry.states.has(key));
