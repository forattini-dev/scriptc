// @rust-only
// @no-engine
// A typed-array source yielded by an ordinary array iterator may be absent.
const pieces: Uint8Array[] = [new Uint8Array([1, 2]), new Uint8Array([3])];
const target = new Uint8Array(5);
let offset = 0;
for (const piece of pieces) {
  target.set(piece, offset);
  offset += piece.length;
}
console.log("bytes", target.join(","));
const missing: Uint8Array[] = [];
missing.length = 1;
let trace = "";
function destination(): Uint8Array {
  trace += "r";
  return target;
}
function position(): number {
  trace += "o";
  return 0;
}
for (const piece of missing) {
  try {
    destination().set((trace += "s", piece), position());
  } catch (error) {
    console.log("missing", trace, error instanceof TypeError, (error as Error).message);
  }
  for (const at of [-1, -0.5, 0, 5, Infinity, -Infinity, NaN]) {
    try {
      target.set(piece, at);
    } catch (error) {
      console.log("offset", String(at), error instanceof RangeError, (error as Error).message);
    }
  }
}
console.log("unchanged", target.join(","));
