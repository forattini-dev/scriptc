// @rust-only
// @no-engine
export {};
let trace = "";
function update(value: number): number { trace = trace + "update:" + value + ";"; return value + 1; }
for (let i = 0; i < 3; i = update(i)) {
  try { trace = trace + "body:" + i + ";"; if (i === 0) continue; break; }
  finally { trace = trace + "finally:" + i + ";"; }
}
console.log("continue", trace);
function returning(): number {
  for (let i = 0; i < 2; i = update(i)) { try { return i + 7; } finally { trace = trace + "return-finally;"; } }
  return -1;
}
trace = "";
console.log("return", returning(), trace);
trace = "";
for (let i = 0; i < 2; i = update(i)) { try { continue; } finally { trace = trace + "override;"; break; } }
console.log("override", trace);
