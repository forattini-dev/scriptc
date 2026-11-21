// @rust-only
// @no-engine
const colors = new Map<number, number>([
  [0x112233, 2],
  [0xabcdef, 5],
  [0x445566, 3],
]);

const sorted = Array.from(colors.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 2);

console.log('entries', sorted.map(([key]) => key).join(','));
const copied = Array.from(colors.entries());
console.log('fresh', copied !== Array.from(colors.entries()), copied.length);
