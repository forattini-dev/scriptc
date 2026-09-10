const values = [-0, 0, -1, 1.75, -1.75, 255, 256, 257, -257, NaN, Infinity, -Infinity,
  2147483648, 4294967295, 4294967296, 9007199254740991, 9007199254740992, 1e100, -1e100];
function store(input: number[]): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out[i * 2] = input[i] & 255;
    out[i * 2 + 1] = 255 & input[i];
  }
  return out;
}
console.log("bytes", store(values).join(","));
const wide = new Uint32Array(2);
const floats = new Float64Array(2);
wide[0] = -1 & 255; wide[1] = -1;
floats[0] = -1 & 255; floats[1] = -1;
console.log("wide", wide[0], wide[1], floats[0], floats[1]);
const small = new Uint8Array(2);
small[0] = 255 & 127; small[1] = 255 & 511;
console.log("masks", small.join(","));

function order(): void {
  let data = new Uint8Array(2);
  const original = data;
  let index = 0;
  data[index++] = (data = new Uint8Array([7, 8]), index++) & 255;
  console.log("snapshot", original.join(","), data.join(","), index);
}
order();
function calls(): void {
  const out = new Uint8Array(2);
  let counter = 0;
  function next(): number { counter++; return -counter; }
  for (let i = 0; i < 2; i++) out[i] = next() & 255;
  console.log("calls", out.join(","), counter);
}
calls();
