// @rust-only
// @no-engine
const cache = new Map<string, (...args: unknown[]) => string>();
function describe(...args: unknown[]): string {
  return args.map(value => typeof value === 'string' ? value : String(value)).join('|');
}
cache.set('describe', describe);
const saved = cache.get('describe');
if (saved !== undefined) {
  console.log(saved(), saved('a', 2, true));
  const values: unknown[] = ['b', 3];
  console.log(saved(...values));
  console.log(saved === cache.get('describe'));
}
function withPrefix(prefix: string, ...args: unknown[]): string { return prefix + describe(...args); }
console.log(withPrefix('x:', 'a', 4));
