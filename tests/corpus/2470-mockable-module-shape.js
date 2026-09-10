// The mockable-clock module shape: a JSDoc-generic factory whose declared
// return carries `T[K]`-typed members (the indexed access resolves against
// the instantiation's record binding), a hasOwn-guarded runtime-keyed
// write into a fixed-shape record of same-typed closures, and an
// Object.assign restore over the same shape.
/**
@template {{ [key: string]: any }} T
@template {keyof T} K
@param {T} implementations
@returns {{
  mocked: T,
  implementations: T,
  mockImplementation(functionality: K, implementation: T[K]): void,
  mockImplementations(overrideImplementations: T): void,
  mockRestore(): void,
}}
*/
function createMockable(implementations) {
  const mocked = { ...implementations };
  const mockImplementation = (functionality, implementation) => {
    if (!Object.hasOwn(implementations, functionality)) {
      throw new Error(`Unexpected mock '${functionality}'.`);
    }
    // @ts-expect-error -- the generic-write pattern (the source shape)
    mocked[functionality] = implementation;
  };
  const mockImplementations = (overrideImplementations) => {
    for (const [functionality, implementation] of Object.entries(
      overrideImplementations,
    )) {
      mockImplementation(functionality, implementation);
    }
  };
  const mockRestore = () => {
    Object.assign(mocked, implementations);
  };

  return {
    mocked,
    implementations,
    mockImplementation,
    mockImplementations,
    mockRestore,
  };
}

const box = createMockable({ tick: () => console.log("real tick") });
box.mocked.tick();
box.mockImplementation("tick", () => console.log("mocked tick"));
box.mocked.tick();
box.mockRestore();
box.mocked.tick();
// Exercise the adapted function's record argument, not just its presence in
// the returned API. The dynamic body reads its callable fields via entries.
box.mockImplementations({ tick: () => console.log("batch tick") });
box.mocked.tick();
box.mockRestore();
box.mocked.tick();
try {
  box.mockImplementation("tock", () => {});
} catch (e) {
  console.log("caught:", e.message);
}
console.log("done");
