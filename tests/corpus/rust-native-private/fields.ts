// @rust-only
// @no-engine
export {};
class Box {
  #value = 3;
  #empty: number | undefined;
  "#value" = 99;
  get value(): number { return this.#value; }
  set value(next: number) { this.#value = next; }
  clear(): boolean { return (this.#empty = undefined) === undefined; }
  fill(next: number): number { return (this.#empty = next); }
  absent(): boolean { return this.#empty === undefined; }
  readPublic(): boolean { return this["#value"] === 99; }
}
const first = new Box();
const second = new Box();
const alias = first;
console.log("values", first.value, second.value, first.absent(), first.clear());
console.log("assignment", (alias.value = 7), first.value, second.value, alias === first);
console.log("public spelling", first.readPublic());
class Hidden {
  #secret = 8;
  check(other: unknown): boolean { return (other as any)["#secret"] === undefined; }
}
const hidden = new Hidden();
console.log("hidden", hidden.check(hidden));
console.log("optional assignment", first.fill(11), first.absent());

class PreviouslyRefused { #value = 1; } new PreviouslyRefused();
