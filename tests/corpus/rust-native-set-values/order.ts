// @rust-only
// @no-engine
const set = new Set<unknown>();
function receiver(): Set<unknown> { console.log("receiver"); return set; }
function value(label: string): { label: string } { console.log("value", label, set.size); return { label }; }
receiver().add(value("argument"));
const seeded = new Set<unknown>([value("first"), value("second"), value("third")]);
console.log("sizes", set.size, seeded.size);
function fail(): number { console.log("throw seed"); throw new Error("seed failed"); }
try { const bad = new Set<unknown>([value("before"), fail(), value("after")]); console.log(bad.size); }
catch (error) { if (error instanceof Error) console.log("caught", error.message); }
console.log("still", set.size);
