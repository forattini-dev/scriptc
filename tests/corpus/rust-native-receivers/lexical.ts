// @rust-only
// @no-engine
export {};
function outer(this: { tag: string }, suffix: string): () => string {
  const arrow = () => this.tag + suffix;
  return arrow;
}
const receiver = { tag: "outer" };
const arrow = outer.call(receiver, "!");
console.log("lexical", arrow(), arrow.call({ tag: "wrong" }));
receiver.tag = "changed";
console.log("lexical", arrow());
const top = (): any => this;
console.log("lexical", top() === undefined, top.call({}) === undefined);
function nested(this: { tag: string }): () => () => string {
  return () => () => this.tag;
}
console.log("lexical", nested.call(receiver)()());
function inner(this: any): boolean { return this === undefined; }
function bound(this: { tag: string }): boolean { return this.tag === "changed" && inner(); }
console.log("lexical", bound.call(receiver), inner.call(receiver), inner());

class Holder {
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  make(): () => string { return () => this.tag; }
}
const instance = new Holder("class");
const getter = instance.make();
console.log("class", getter(), getter.call({tag: "wrong"}));
instance.tag = "mutated";
console.log("class-live", getter());

const cycle: {tag: string; callback?: () => string} = {tag: "cycle"};
const cyclicCallback = outer.call(cycle, "!");
cycle.callback = cyclicCallback;
console.log("cycle", cyclicCallback());

class NumericHolder { method(): () => number { return () => this.value; } value = 1; }
console.log("numeric", new NumericHolder().method()());
class PrivateHolder {
  #value = "private";
  #method(): string { return this.#value; }
  read(): () => string { return () => this.#method(); }
}
const privateReader = new PrivateHolder().read();
console.log("private", privateReader(), privateReader.call({}));
