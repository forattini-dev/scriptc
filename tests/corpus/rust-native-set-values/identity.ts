// @rust-only
// @no-engine
type Scope = { id: number };
const first = { id: 1 }; const second = { id: 1 };
const scopes = new Set<Scope>();
console.log("insert", scopes.add(first) === scopes, scopes.add(first) === scopes, scopes.size);
console.log("identity", scopes.has(first), scopes.has(second), scopes.delete(second));
first.id = 8; console.log("mutation", scopes.has(first), first.id);
function has(scope: Scope, values: ReadonlySet<Scope>): boolean { return values.has(scope); }
const aliases: Set<Scope>[] = [scopes, scopes];
console.log("aliases", aliases[0] === aliases[1], has(first, aliases[1]));
console.log("delete", scopes.delete(first), scopes.delete(first), scopes.size);
scopes.add(second); scopes.add(first); console.log("readd", scopes.size, scopes.has(second));
scopes.clear(); console.log("clear", scopes.size, scopes.has(first));
const one = Symbol("one"); const other = Symbol("one");
const symbols = new Set<symbol>([one, one, other, Symbol.for("shared"), Symbol.for("shared")]);
console.log("symbols", symbols.size, symbols.has(one), symbols.has(Symbol.for("shared")), symbols.delete(other));
const set = new Set([{id: 1}]); console.log("previous boundary", set.size);
