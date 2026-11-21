// @rust-only
// @no-engine
const source = [257, -1, 2.9];
const output = new Uint8Array(5);
output.set(source, 1);
source[0] = 9;
console.log("typed set", output.join(","), source.join(","));
