// @rust-only
// @no-engine
export {};
let trace = "";
const object = { tag: "holder" };
function receiver(): any { trace = trace + "r"; return object; }
function argument(): string { trace = trace + "a"; return "arg"; }
function inspect(this: { tag: string }, value: string = this.tag): string {
  trace = trace + "b";
  return this.tag + ":" + value;
}
console.log("call", inspect.call(receiver(), argument()), trace);
trace = "";
console.log("default", inspect.call(receiver()), trace);
function throwing(this: { tag: string }): void { console.log("throw", this.tag); throw "oops"; }
try { throwing.call(object); } catch (error) { console.log("caught", error === "oops"); }
function bare(this: any): boolean { return this === undefined; }
console.log("after", bare(), bare.call(null), bare.call(undefined));
const holder = { tag: "method", method: function(this: { tag: string }, text: string): string { return this.tag + text; } };
console.log("member", holder.method("!"));
const extracted: any = holder.method;
try { extracted("?"); } catch (error) { console.log("extracted", error instanceof TypeError); }
const custom = { tag: "own", call: function(this: { tag: string }, value: string): string { return this.tag + value; } };
console.log("custom", custom.call("!"));
const erased: any = holder;
console.log("dynamic", (erased.method("?") as string));

const callable = Object.assign(function(this: any): boolean { return this === undefined; }, {meta: 1});
console.log("callable", callable(), callable.call(object));
const callableHolder = { tag: "outer", callback: Object.assign(function(this: {tag: string}): string { return this.tag; }, {meta: 2}) };
console.log("callable-member", callableHolder.callback());
