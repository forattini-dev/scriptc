// A runtime resource registry erases its owners (tuiuiu getRuntimeResource):
// the registry holds `unknown`, while the owner keeps WeakMap state fields.
const resources = new Map<symbol, unknown>();

function getRuntimeResource<T>(key: symbol, create: () => T): T {
  if (!resources.has(key)) resources.set(key, create());
  return resources.get(key) as T;
}

interface Node {
  readonly name: string;
}

class DirtyRegistry {
  private states = new WeakMap<Node, number>();
  private version = 0;

  mark(node: Node): number {
    this.version += 1;
    this.states.set(node, this.version);
    return this.version;
  }

  state(node: Node): number {
    return this.states.get(node) ?? -1;
  }

  reset(): void {
    this.states = new WeakMap();
    this.version = 0;
  }
}

const KEY = Symbol("dirty-registry");
const registry = (): DirtyRegistry => getRuntimeResource(KEY, () => new DirtyRegistry());

const a = { name: "a" };
const b = { name: "b" };
console.log(registry().mark(a), registry().mark(b), registry().mark(a));
console.log(registry().state(a), registry().state(b), registry() === registry());
registry().reset();
console.log(registry().state(a), resources.size);
