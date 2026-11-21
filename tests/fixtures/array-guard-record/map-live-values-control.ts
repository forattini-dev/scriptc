function stop(map: Map<string, number>) {
  const visited: number[] = [];
  for (const value of map.values()) {
    visited.push(value);
    if (value === 2) return visited.join(',');
  }
  return 'not reached';
}
console.log('return', stop(new Map([['a', 1], ['b', 2], ['c', 3]])));
try {
  for (const value of new Map([['a', 1], ['b', 2], ['c', 3]]).values()) {
    if (value === 2) throw new TypeError('stop');
  }
} catch (error) { console.log('throw', error instanceof TypeError); }
const captures: Array<() => number> = [];
for (const value of new Map([['a', 4], ['b', 5], ['c', 6]]).values()) {
  captures.push(() => value);
}
console.log('capture', captures[0](), captures[1](), captures[2]());
