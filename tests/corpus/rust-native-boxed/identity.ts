// @rust-only
// @no-engine
function brands(value: any): void {
  console.log("brands", value instanceof Number, value instanceof String, value instanceof Boolean);
}
const n = new Number(4); const s = new String("hello"); const b = new Boolean(false);
brands(n); brands(s); brands(b); brands(4); brands("hello"); brands(false); brands(null); brands(undefined); brands({n: 4});
const alias = n;
console.log("identity", alias === n, n === new Number(4), s === new String("hello"), b === new Boolean(false));
const rows: unknown[] = [n, s, b, alias];
console.log("array", rows[0] === rows[3], rows[0] === n);
const map = new Map<unknown, string>(); map.set(n, "one"); map.set(alias, "alias"); map.set(new Number(4), "other");
console.log("map", map.size, map.get(n));
const set = new Set<unknown>([n, alias, new Number(4), s, b]);
console.log("set", set.size, set.has(n));
class Custom { value: number = 1; }
const custom = new Custom();
console.log("shadow class", custom instanceof Custom);
