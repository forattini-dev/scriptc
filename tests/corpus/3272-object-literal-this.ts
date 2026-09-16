// @rust-only
// `this` in an object-literal method: the method's receiver is the literal itself, so a method may call a sibling
// through `this` (Redcode's Connection shape, where executeUnprepared forwards to execute). The literal is built into
// a hidden local the methods capture, which the cycle collector reclaims.
interface Store {
  readonly base: number;
  readonly scale: number;
  value(n: number): number;
  twice(n: number): number;
  label(): string;
  plain(n: number): number;
}

const store: Store = {
  base: 10,
  scale: 3,
  value(n: number): number {
    return this.base + n * this.scale;
  },
  // A method calling a SIBLING through `this` — the shape that blocked Redcode.
  twice(n: number): number {
    return this.value(n) + this.value(n);
  },
  label(): string {
    return `base=${this.base} scale=${this.scale}`;
  },
  // No `this`: lowers exactly as before, with no receiver.
  plain(n: number): number {
    return n * 2;
  },
};

console.log(store.value(1), store.value(0), store.value(-2));
console.log(store.twice(1), store.twice(4));
console.log(store.label());
console.log(store.plain(21));
console.log(store.base, store.scale);

// A second literal of the same shape keeps its OWN receiver.
const other: Store = {
  base: 100,
  scale: 1,
  value(n: number): number {
    return this.base + n * this.scale;
  },
  twice(n: number): number {
    return this.value(n) + this.value(n);
  },
  label(): string {
    return `base=${this.base} scale=${this.scale}`;
  },
  plain(n: number): number {
    return n;
  },
};
console.log(other.value(5), other.twice(5), other.label());
console.log(store.value(5), other.value(5));

// Methods reached through a function parameter still dispatch on the passed object.
function report(s: Store): string {
  return `${s.label()} -> ${s.value(2)}/${s.twice(2)}`;
}
console.log(report(store));
console.log(report(other));

// Nested arrows inherit the method's `this`.
const nested = {
  seed: 7,
  compute(ns: number[]): number[] {
    return ns.map((n) => n + this.seed);
  },
};
console.log(JSON.stringify(nested.compute([1, 2, 3])));
