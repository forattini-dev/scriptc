const source = new Uint8Array(256);
for (let i = 0; i < source.length; i++) source[i] = 255 - i;

let comparisons = 0;
const sorted = source.toSorted((a, b) => {
  comparisons++;
  if (comparisons > 5000) throw new Error("Uint8Array sort exceeded comparison budget");
  return a - b;
});
console.log(sorted[0], sorted[255], source[0], source[255]);

const descending = source.toSorted((a, b) => b - a);
console.log(descending[0], descending[255], source[0], source[255]);

const defaults = new Uint8Array([9, 1, 7, 1, 5, 2]).toSorted();
console.log(defaults[0], defaults[1], defaults[2], defaults[3], defaults[4], defaults[5]);
