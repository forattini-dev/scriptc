// A module namespace object as a VALUE: `import * as Ns` passed to a
// function, enumerated, and read through a structural parameter type.
// The static tier builds a record of the module's value exports at the
// use site, so structural flows, enumeration, and member reads agree
// with Node. (Key ORDER follows the record's declaration order, Node's
// namespace is alphabetical, and identity — `Ns === Ns` — sees fresh
// records: both are documented divergences, so the program sorts its
// keys and never compares identity.)
import * as Event from "./event.ts";
import { Catalog } from "./catalog.ts";

console.log(Object.keys(Event).sort().join(","));
console.log(Object.values(Event).length);
const describe = (ns: { kind: string; define(name: string): string }): string => ns.define("x") + "/" + ns.kind;
console.log(describe(Event));
console.log(Catalog.Event.kind, Catalog.Event.ids.length);
console.log(Object.keys(Catalog.Event).sort().join("|"));
const table = { first: Event, second: Event };
console.log(table.first.define("a"), table.second.ids[1]);
