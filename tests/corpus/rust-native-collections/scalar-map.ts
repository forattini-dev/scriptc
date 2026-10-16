// @rust-only
// @no-engine
function create(): ReadonlyMap<string, number> { return new Map<string, number>([["answer", 42]]); }
const map = create();
console.log("scalar-map", map.size, map.get("answer") === 42, map.get("missing") === undefined);
