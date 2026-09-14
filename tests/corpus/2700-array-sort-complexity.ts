// Stable sort must stay scalable across ordered, adversarial, random, and
// duplicate-heavy inputs. The budget is deliberately loose for a merge sort
// but rejects the old quadratic insertion sort on the larger cases.
function checkBudget(label: string, input: number[], budget: number): void {
  let comparisons = 0;
  const sorted = input.slice();
  sorted.sort((a, b) => {
    comparisons++;
    if (comparisons > budget) throw new Error(label + " exceeded comparison budget");
    return a - b;
  });
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1]! > sorted[i]!) throw new Error(label + " was not sorted");
  }
  console.log(label, sorted.length, sorted[0], sorted[sorted.length - 1]);
}

const size = 4096;
const ascending: number[] = [];
const descending: number[] = [];
const random: number[] = [];
const duplicates: number[] = [];
let seed = 123456789;
for (let i = 0; i < size; i++) {
  ascending.push(i);
  descending.push(size - i - 1);
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  random.push(seed % size);
  duplicates.push((i * 17) % 31);
}

checkBudget("ascending", ascending, size * 4);
checkBudget("descending", descending, size * 32);
checkBudget("random", random, size * 32);
checkBudget("duplicates", duplicates, size * 32);

const ties = [
  { key: 1, order: "a" },
  { key: 0, order: "b" },
  { key: 1, order: "c" },
  { key: 0, order: "d" },
];
ties.sort((a, b) => a.key - b.key);
console.log(ties.map((entry) => entry.order).join(","));
