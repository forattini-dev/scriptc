// @rust-only
// @no-engine
export {};
let order = "";
function disc(value: number): number { order += "d"; return value; }
function test(value: number): number { order += String(value); return value; }
function run(value: number): void {
  order = "";
  switch (disc(value)) {
    case test(1): order += "a"; break;
    default: order += "m";
    case test(2): order += "b";
    case test(3): order += "c"; break;
  }
  console.log("order", order);
}
run(1); run(2); run(3); run(4);
function fail(): number { order += "e"; throw new Error("test"); }
try { switch (disc(1)) { case test(1): order += "ok"; break; case fail(): break; } }
catch { console.log("unexpected"); }
console.log("lazy", order);
try { switch (disc(0)) { case fail(): break; default: console.log("wrong"); } }
catch (error) { if (error instanceof Error) console.log("throw", error.message, order); else throw error; }
