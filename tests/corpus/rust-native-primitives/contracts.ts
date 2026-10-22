// @ts-nocheck
// @rust-only
// @no-engine
function numeric(value: number | string | boolean | null | undefined): void {
  console.log("union", Math.floor(value), Math.min(4, value), "x".repeat(Math.min(3, Math.max(0, Math.floor(value)))));
}
numeric(2.9); numeric("2.9"); numeric(true); numeric(null); numeric(undefined);
function spaces(spaceParam: number): string { return " ".repeat(Math.min(10, Math.max(0, Math.floor(spaceParam)))); }
console.log("indent", spaces(-1).length, spaces(3.9).length, spaces(20).length, spaces(1 / 0).length, spaces(0 / 0).length);
