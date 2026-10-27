// @rust-only
// @no-engine
export {};
for (const value of [1, 2, 3]) {
  try {
    switch (value) {
      case 1: try { continue; } finally { console.log("continue-finally", value); }
      case 2: try { break; } finally { console.log("break-finally", value); }
      default: for (const inner of [4, 5]) { if (inner === 4) break; console.log("wrong"); }
    }
    console.log("after", value);
  } finally { console.log("outer-finally", value); }
}
function returned(value: number): string {
  try {
    switch (value) {
      case 1: try { return "one"; } finally { console.log("return-finally"); }
      default: throw new Error("switch");
    }
  } finally { console.log("function-finally"); }
}
console.log(returned(1));
try { returned(2); } catch (error) { if (error instanceof Error) console.log("caught", error.message); else throw error; }
for (const value of [1, 2]) {
  switch (value) {
    case 1: try { break; } finally { continue; }
    default: console.log("replacement", value);
  }
  console.log("tail", value);
}
