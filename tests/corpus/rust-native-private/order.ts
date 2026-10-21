// @rust-only
// @no-engine
// @ts-nocheck
export {};
function mark(label: string, value: number): number { console.log("mark", label, value); return value; }
class Ordered {
  #first = mark("private first", 1);
  public = mark("public", this.#first);
  #last = mark("private last", this.public + 1);
  constructor(value = mark("default", this.#last)) { console.log("constructor", value); }
  get value(): number { return this.#last; }
}
console.log("ordered", new Ordered().value);
class EarlyRead { #early = this.#later; #later = mark("must not run", 1); }
class EarlyWrite { #early = (this.#later = mark("rhs before brand", 2)); #later = 1; }
try { new EarlyRead(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
try { new EarlyWrite(); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
class Box {
  #value = 1;
  set(other: unknown): number { return ((other as Box).#value = mark("write rhs", 7)); }
}
function receiver(): Box { console.log("receiver"); return new Box(); }
try { receiver().set(null); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
