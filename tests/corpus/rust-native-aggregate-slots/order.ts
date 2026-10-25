// @rust-only
// @no-engine
let trace = "";
function mark(label: string): boolean { trace = trace + label; return true; }
function effect(): void { trace = trace + "v"; }
const state = { key: mark("u") ? undefined : undefined, empty: mark("n") ? null : null, children: [], side: effect() };
console.log("order", trace, state.key === undefined, state.empty === null, state.children.length, state.side === undefined);
const arrays = { units: [mark("u") ? undefined : undefined, mark("u") ? undefined : undefined], nulls: [mark("n") ? null : null] };
console.log("nested order", trace, arrays.units.length, arrays.units[0] === undefined, arrays.nulls[0] === null);
