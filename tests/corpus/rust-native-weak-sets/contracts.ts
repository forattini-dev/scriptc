// @rust-only
// @no-engine
type Key = { id: number };
const first: Key = { id: 1 }; const second: Key = { id: 1 };
const set = new WeakSet<Key>([first, first]);
console.log('seed', set.has(first), set.has(second));
const alias = set;
console.log('add', set.add(second) === set, alias.has(second));
console.log('delete', set.delete(first), set.delete(first), set.has(first), set.has(second));
const other = new WeakSet<Key>();
console.log('owners', other.has(second), other.add(second) === other, other.delete(second), set.has(second));
class Other {}
console.log('identity', alias === set, other !== set, set instanceof WeakSet, set instanceof Other);
const empty = new WeakSet<Key>([]);
console.log('empty', empty.has(first));
const nullable = new WeakSet<Key>(null);
const missing = new WeakSet<Key>(undefined);
console.log('nullish', nullable.has(first), missing.has(first));
function seeded(seed: Key[] | null | undefined): WeakSet<Key> { return new WeakSet(seed); }
console.log('union', seeded([first]).has(first), seeded(null).has(first), seeded(undefined).has(first));
function erased(key: unknown): boolean {
  // @ts-expect-error Invalid primitive keys intentionally exercise runtime checks.
  return set.has(key);
}
console.log('erased', erased(second), erased({ id: 1 }), erased(null), erased(undefined), erased(1), erased(false), erased('key'));
export {};
