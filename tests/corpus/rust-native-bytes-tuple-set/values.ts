// @rust-only
// @no-engine
export {};
const signature = [137, 80, 78, 71] as const;
const bytes = new Uint8Array(6);
bytes.set(signature, 1);
console.log("signature", bytes.join(","));
const tuple: [number, number] = [258, -1];
function offset(): number { tuple[0] = 7; return 2; }
bytes.set(tuple, offset());
console.log("late", bytes.join(","));
const floats = new Float32Array(4);
floats.set([1.5, -2] as const, 1);
console.log("floats", floats.join(","));
try { bytes.set(signature, 4); }
catch (error) { console.log("bounds", error instanceof RangeError, bytes.join(",")); }
const empty = [] as const;
bytes.set(empty, bytes.length);
bytes.set([300, -3] as const, Number("bad"));
console.log("empty-nan", bytes.join(","));
