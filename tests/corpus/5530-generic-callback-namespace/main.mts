import * as helpers from './resource.mjs';
let count = 0;
class Registry {
  states = new WeakMap<object, number>();
  constructor() { count++; }
  set(key: object, value: number): void { this.states.set(key, value); }
  get(key: object): number | undefined { return this.states.get(key); }
}
function makeRegistry(): Registry { return helpers.resource(() => new Registry()); }
const key = {};
const first = makeRegistry();
const second = makeRegistry();
first.set(key, 42);
second.set(key, 73);
console.log('distinct', first !== second, 'created', count, 'values', first.get(key), second.get(key));
