function fill(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) {
    out[i] = source[i] + 3;
    if (i > 0) out[i] = out[i] + out[i - 1];
  }
  return out;
}
console.log("fill", fill(new Uint8Array([1, 2, 3, 4])).join(","));

function ordered(): Uint8Array {
  const out = new Uint8Array(4);
  let index = 0;
  for (let i = 0; i < 2; i++) {
    out[index++] = index + out[index];
  }
  return out;
}
console.log("order", ordered().join(","));

function exceptions(): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    try {
      out[i] = i;
      if (i === 2) throw new Error("change path");
    } catch {
      out[i] = 9;
    } finally {
      out[i] = out[i] + 1;
    }
    if (i === 1) continue;
    if (i === 2) break;
  }
  out[3] = 17;
  return out;
}
console.log("exceptions", exceptions().join(","));

function snapshots(): Uint8Array {
  let out = new Uint8Array(2);
  const old = out;
  for (let i = 0; i < 1; i++) out[0] = (out = new Uint8Array([5, 6]), 7);
  console.log("snapshot", old.join(","));
  return out;
}
console.log("replacement", snapshots().join(","));

function escapedBefore(): Uint8Array {
  const out = new Uint8Array(2);
  const alias = out;
  for (let i = 0; i < 2; i++) { out[i] = i + 1; alias[i] = alias[i] + 10; }
  return out;
}
function escapedInside(): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) { const alias = out; out[i] = i + 1; alias[i] = alias[i] + 1; }
  return out;
}
function captured(): Uint8Array {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) {
    const change = (): number => { out[0] = 9; return i; };
    out[i] = change();
  }
  return out;
}
console.log("aliases", escapedBefore().join(","), escapedInside().join(","), captured().join(","));

function earlyReturn(): number {
  const out = new Uint8Array(2);
  for (let i = 0; i < 2; i++) { out[i] = 7; if (i === 1) return out[i]; }
  return 0;
}
console.log("return", earlyReturn());

function labels(): number {
  let sum = 0;
  outer: for (let j = 0; j < 3; j++) {
    const out = new Uint8Array(2);
    for (let i = 0; i < 2; i++) {
      out[i] = i + j;
      if (i === 1) continue outer;
      sum += out[i];
    }
  }
  return sum;
}
console.log("labels", labels());
