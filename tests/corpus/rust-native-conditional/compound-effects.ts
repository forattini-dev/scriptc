// @rust-only
// @no-engine
let value = 10;
let calls = 0;
function right(): number { calls++; console.log("right", value); value = 100; return 3; }
console.log("old before right", value += right(), value, calls);
function fail(): number { console.log("throw right"); throw new Error("right"); }
try { value *= fail(); } catch (error) { console.log("no write", error instanceof Error, value); }
function captured(): void {
  let inner = 4;
  const change = (): number => { inner = 9; return 2; };
  const read = (): number => inner;
  console.log("captured", inner *= change(), read());
}
captured();
let text = "left";
function suffix(): string { console.log("suffix", text); text = "changed"; return "right"; }
console.log("string old", text += suffix(), text);
console.log("lazy", false ? (value += 1) : value, true ? value : (value += 1), value);
value = 1;
console.log("nested writes", value += (value += 3), value);
