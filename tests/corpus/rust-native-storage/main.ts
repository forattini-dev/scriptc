// @rust-only
// @no-engine
import { live, revision, current, replace, recursive, groups, registry, callback, localAlias } from "./barrel.ts";
import type { Operation } from "./state.ts";

const original = current();
const alias = original[0];
console.log(original === live, alias === live[0], original.length, alias.name);
alias.name = "changed";
console.log("aliases", current()[0].name, localAlias(alias)());
replace();
console.log(revision, recursive(3), callback(), current() === live, original === live, live[0].name);
const group = groups["primary"];
if (group !== undefined) console.log(group === original, group[0].name);
const registered = registry.get("primary");
if (registered !== undefined) console.log(registered === original, registered[0] === alias);
const nested: Operation[][] = [original, live];
console.log(nested[0] === original, nested[1][0].enabled);
const optional: (Operation | undefined)[] = [alias, undefined];
const selected = optional[0];
if (selected !== undefined) console.log("selected", selected.name, selected === alias);
const absent = optional[1];
console.log(absent === undefined);
const tags = alias.tags;
if (tags !== undefined) console.log(tags.length, tags[0]);
const dictionary: Record<string, Operation[]> = { saved: original };
console.log(dictionary["saved"][0] === alias);
