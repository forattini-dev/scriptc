function classify(value: unknown): string {
  if (value instanceof Float32Array) return "f32";
  if (value instanceof Float64Array) return "f64";
  if (value instanceof Uint8Array) return "u8";
  return "other";
}

const values: unknown[] = [
  new Float32Array([1]),
  new Float64Array([2]),
  new Uint8Array([3]),
  "4",
];
console.log(values.map(classify).join(","));

function snapshot(value: Float32Array | Float64Array): string {
  return Array.from(value).join(",");
}
console.log(snapshot(new Float32Array([1.5, 2.5])), snapshot(new Float64Array([3.5])));
