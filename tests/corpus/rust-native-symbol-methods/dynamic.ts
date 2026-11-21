// @rust-only
// @no-engine
export {};

const dispose = Symbol('resource.dispose');

class Resource {
  count = 0;

  [dispose](): void {
    this.count++;
  }
}

function createResource<T>(create: () => T): T {
  return create();
}

const resource = createResource(() => new Resource());
const erased: unknown = resource;

if (typeof erased === 'object' && erased !== null && dispose in erased) {
  const first = (erased as any)[dispose];
  const second = (erased as any)[dispose];
  console.log(first === second);
  (erased as any)[dispose]();
}

console.log(resource.count);
