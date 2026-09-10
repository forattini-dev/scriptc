import { Buffer } from "node:buffer";
// Integer induction must preserve JS observations, control flow, views, and
// evaluation order. Captured/mutated counters and async frames stay generic.
function exercise(bytes: Uint8Array): number {
  let total = 0;
  outer: for (let i = 0; i < bytes.length; i++) {
    if (i === 1) continue outer;
    try {
      console.log("number", i / 2);
    } finally {
      console.log("finally", i, typeof i, Object.is(i, -0));
    }
    for (let j = 0; j < bytes.length; j++) {
      if (j === 2) continue;
      total += bytes[i] + bytes[j] + i / 2;
      if (i === 3) break outer;
    }
  }
  return total;
}
console.log("control", exercise(new Uint8Array([2, 4, 6, 8])));

function changes(): void {
  let bytes = new Uint8Array([1, 2, 3]);
  const original = bytes;
  function replace(): number {
    bytes = new Uint8Array([7, 8]);
    return 19;
  }
  for (let i = 0; i < original.length; i++) {
    if (i === 0) bytes[i] = replace();
  }
  console.log("snapshot", original.join(","), bytes.join(","));
  for (let i = 0; i < bytes.length; i++) {
    if (i === 0) bytes = new Uint8Array([11]);
    console.log("shorter", bytes[i]);
  }
}
changes();

function views(): void {
  const words = new Uint32Array([1, 2, 3, 4]);
  const view = words.subarray(1, 3);
  for (let i = 0; i < view.length; i++) view[i] = view[i] + 4294967295;
  const raw = Buffer.from(words.buffer);
  for (let i = 0; i < raw.length; i++) raw[i] = 9;
  console.log("views", words[0], words[1], words[2], words[3], view[0], view[1]);
  const floats = new Float64Array([1.25, -0, 3.5]);
  for (let i = 0; i < floats.length; i++) console.log("float", floats[i], i / 2);
}
views();

function fallback(bytes: Uint8Array): void {
  const callbacks: (() => number)[] = [];
  for (let i = 0; i < bytes.length; i++) callbacks.push(() => i);
  console.log("captures", callbacks.map(fn => fn()).join(","));
  for (let i = 0; i < bytes.length; i++) {
    if (i === 1) i++;
    console.log("mutated", i, bytes[i]);
  }
}
fallback(new Uint8Array([3, 5, 7]));

async function afterAwait(bytes: Uint8Array): Promise<void> {
  for (let i = 0; i < bytes.length; i++) {
    await Promise.resolve();
    console.log("await", i, bytes[i]);
  }
}
await afterAwait(new Uint8Array([10, 20]));
