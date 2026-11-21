const values = new Set([1, 2]);
const visited: number[] = [];
for (const value of values) {
  visited.push(value);
  if (value === 1) {
    values.delete(2);
    values.add(3);
  }
}
console.log(visited.join(','));
