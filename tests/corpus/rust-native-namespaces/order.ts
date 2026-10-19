// @rust-only
// @no-engine
import * as source from "./counter.ts";
import * as barrel from "./barrel.ts";
const alias = source;
const exported = barrel;
function receiver(): typeof source { console.log("receiver"); source.set(7); return alias; }
function argument(): number { console.log("argument"); source.set(9); return 13; }
console.log("read after receiver", receiver().count);
receiver().set(argument());
console.log("after call", alias.count, exported.current, exported.read());
exported.replace(21);
console.log("reexport live", source.count, exported.current, exported.read === alias.read);
function unusedNamespace(Symbol: { value: number }): number { return Symbol.value; }
console.log("shadow", unusedNamespace({ value: 3 }));
console.log("callee snapshot", alias.operation(alias.replaceOperation()), alias.operation(3));
