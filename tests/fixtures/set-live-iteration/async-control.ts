async function run() {
  const values = new Set([1, 2, 3]);
  const visited: number[] = [];
  for (const value of values) {
    visited.push(value);
    await Promise.resolve();
    if (value === 1) { values.delete(2); values.add(4); continue; }
    if (value === 3) break;
  }
  console.log('async-control', visited.join(','), values.size);
}
void run();
