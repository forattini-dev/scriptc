// @rust-only
// @no-engine
// Star resolution terminates in cycles and shares the original functions.
async function main(): Promise<void> {
  const a = await import("./a.ts");
  const b = await import("./b.ts");
  console.log("a keys", Object.keys(a).join(","));
  console.log("b keys", Object.keys(b).join(","));
  console.log("calls", a.fromA(3), a.fromB(3), b.fromA(4), b.fromB(4));
  console.log("identity", a.fromA === b.fromA, a.fromB === b.fromB);
  console.log("cached", a === await import("./a.ts"), b === await import("./b.ts"));
}
main();
console.log("entry");
export {};
