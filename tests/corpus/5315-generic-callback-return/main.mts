import { resource } from "./resource.mjs";

class Registry {
  states = new WeakMap<object, number>();

  set(key: object, value: number): void {
    this.states.set(key, value);
  }

  get(key: object): number | undefined {
    return this.states.get(key);
  }
}

function getRegistry(): Registry {
  return resource(() => new Registry());
}

const registry = getRegistry();
const key = {};
registry.set(key, 42);
console.log(registry.get(key));
