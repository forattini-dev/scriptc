function nested(): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = i + 1;
    const scratch = new Uint8Array(4);
    for (let j = 0; j < 4; j++) scratch[j] = out[j];
    out[i] = scratch[i] + 1;
  }
  return out;
}
console.log("nested", nested().join(","));

function deeper(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) {
    out[i] = source[i];
    const middle = new Uint8Array(source.length);
    for (let j = 0; j < source.length; j++) {
      middle[j] = out[j] + source[j];
      const inner = new Uint8Array(source.length);
      for (let k = 0; k < source.length; k++) inner[k] = out[k] + middle[k];
      middle[j] = inner[j] + 1;
    }
    out[i] = middle[i];
  }
  return out;
}
const input = new Uint8Array([2, 3, 4]);
console.log("deeper", deeper(input).join(","), input.join(","));
