function stop(values: Set<number>) {
  const visited: number[] = [];
  for (const value of values) {
    visited.push(value);
    if (value === 2) return visited.join(',');
  }
  return 'not reached';
}
console.log('return', stop(new Set([1, 2, 3])));
try {
  for (const value of new Set([1, 2, 3])) {
    if (value === 2) throw new TypeError('stop');
  }
} catch (error) {
  console.log('throw', error instanceof TypeError);
}
const captures: Array<() => number> = [];
for (const value of new Set([4, 5, 6])) {
  captures.push(() => value);
}
console.log('capture', captures[0](), captures[1](), captures[2]());
