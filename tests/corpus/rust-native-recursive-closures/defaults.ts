// @rust-only
// @no-engine
function run(): void {
  const factorial = (n = 3): number => n === 0 ? 1 : n * factorial(n - 1);
  console.log("defaults", factorial(), factorial(4));
  const view = new DataView(new Uint8Array([5, 6, 7]).buffer);
  const read = (value: DataView, index: number): number =>
    index === 0 ? value.getUint8(index) : value.getUint8(index) + read(value, index - 1);
  console.log("data-view", read(view, 2));
}
run();
