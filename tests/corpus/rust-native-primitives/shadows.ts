// @rust-only
// @no-engine
function shadow(): void {
  const Math = { floor: (value: number): number => value + 100, min: (a: number, b: number): number => a + b };
  console.log("shadow", Math.floor(1), Math.min(2, 3));
}
const custom = { repeat: (count: number): string => `custom:${count}`, length: 99 };
console.log("custom", custom.repeat(2), custom.length);
shadow();
