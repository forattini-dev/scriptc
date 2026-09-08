// @no-engine
// @rust-only
console.log("before dynamic");
const late = await import("./late.ts");
console.log("dynamic", late.late);

export {};
