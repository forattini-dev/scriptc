// @ts-nocheck
"use strict";
function pair(a: string, b: string): string { return a + b; }
const target: any = pair;
const first: any = target.bind(null, "a");
const second: any = first.bind({ ignored: true }, "b");
console.log("bound", String(first("b")), String(second()), typeof first, first === first, first === second);
console.log("apply", String(first.apply(null, ["c"])), String(first.call(null, "d")));
const bind = Function.bind;
const bindable = bind.bind(bind);
const via = bindable(pair, null).apply(null, ["x"]);
console.log("intrinsic", String(via("y")), bind === Function.bind, typeof bind);
function withThis(this: any, value: string): string { return String(this.label) + value; }
const context: any = { label: "one" };
const source: any = withThis;
const saved: any = source.bind(context, "!");
context.label = "two";
console.log("receiver", String(saved.call({ label: "wrong" })), String(saved()));
const extracted: any = target.bind;
const indirect: any = extracted.call(target, null, "z");
console.log("extracted", String(indirect("!")), extracted === bind);
const alias = bind;
const other = alias.bind(alias);
const viaAlias: any = other(pair, null).apply(null, ["r"]);
let rejected = false;
try { (bind as any)(null); } catch (error) { rejected = error instanceof TypeError; }
console.log("aliases", String(viaAlias("s")), alias === bind, rejected);
