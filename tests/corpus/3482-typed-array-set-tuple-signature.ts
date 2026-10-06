// @no-engine
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const out = new Uint8Array(12);
out.set(SIGNATURE, 0);
console.log(out.join(","));
