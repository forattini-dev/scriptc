import { resource } from './resource.mjs';

let created = 0;
class Registry {
  states = new WeakMap<object, number>();
  constructor() { created++; }
  set(key: object, value: number): void { this.states.set(key, value); }
  get(key: object): number | undefined { return this.states.get(key); }
}
function getRegistry(): Registry { return resource('registry', () => new Registry()); }

const key = {};
const first = getRegistry();
const second = getRegistry();
first.set(key, 42);
console.log('same', first === second, 'created', created, 'value', second.get(key));
second.set(key, 73);
console.log('updated', first.get(key), 'missing', first.get({}));
