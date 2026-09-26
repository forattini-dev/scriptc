const firstOverflowingWasm32Width = 0xffffffe1;
const maxWasm32Width = 0xffffffff;
const firstWidthAboveNodeBigIntLimit = 0x40000001;
let checked = 0;

for (let width = firstOverflowingWasm32Width; width <= maxWasm32Width; width++) {
  if (BigInt.asUintN(width, 1n) !== 1n) throw new Error(`asUintN ${width}`);
  if (BigInt.asIntN(width, -1n) !== -1n) throw new Error(`asIntN ${width}`);
  checked++;
}

console.log("wasm32-width-boundaries", checked, BigInt.asUintN(maxWasm32Width, 1n), BigInt.asIntN(maxWasm32Width, -1n));

for (const width of [firstWidthAboveNodeBigIntLimit, maxWasm32Width]) {
  try {
    BigInt.asUintN(width, -1n).toString(2);
  } catch (error) {
    if (error instanceof Error) console.log("format-width", width, error.name, error.message);
  }
}
