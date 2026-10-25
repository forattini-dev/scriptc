// @rust-only
// @no-engine
export {};
let trace = "";
let index = 0;
function init(): number { trace = trace + "init;"; return 0; }
function condition(): boolean { trace = trace + "cond:" + index + ";"; return index < 3; }
function update(): void { trace = trace + "update;"; index++; }
for (index = init(); condition(); update()) {
  trace = trace + "body:" + index + ";";
  if (index === 1) continue;
  if (index === 2) break;
}
console.log("order", trace, index);
trace = "";
for (let i = init(); i < 0; update()) { trace = trace + "never;"; }
console.log("empty", trace);
function fail(): number { trace = trace + "throw;"; throw new Error("update-failed"); }
trace = "";
try { for (let i = 0; i < 1; fail()) { trace = trace + "body;"; } } catch (error) { console.log("throw", error instanceof Error, trace); }
