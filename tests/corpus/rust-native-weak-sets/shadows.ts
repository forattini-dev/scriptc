// @rust-only
// @no-engine
class WeakSet {
  value: number;
  constructor(value: number) { this.value = value; }
  add(value: number): number { this.value = this.value + value; return this.value; }
  has(value: number): boolean { return this.value === value; }
}
const local = new WeakSet(3);
console.log('local', local.add(4), local.has(7));
export {};
