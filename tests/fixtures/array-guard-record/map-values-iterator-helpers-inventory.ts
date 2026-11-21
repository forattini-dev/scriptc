function observe(it: any, mode: number): string {
  if (mode === 0) return typeof it.next;
  if (mode === 1) return typeof it.return;
  if (mode === 2) return typeof it.throw;
  if (mode === 3) return typeof it.map;
  if (mode === 4) return typeof it.filter;
  if (mode === 5) return typeof it.take;
  if (mode === 6) return typeof it.drop;
  if (mode === 7) return typeof it.flatMap;
  if (mode === 8) return typeof it.reduce;
  if (mode === 9) return typeof it.toArray;
  if (mode === 10) return typeof it.forEach;
  if (mode === 11) return typeof it.some;
  if (mode === 12) return typeof it.every;
  if (mode === 13) return typeof it.find;
  if (mode === 14) return typeof it[Symbol.iterator];
  return String(it[Symbol.toStringTag]);
}
for (let round = 0; round < 2; round++) for (let mode = 0; mode < 16; mode++) {
  console.log(round, mode, observe(new Map<string, number>([['a', 1]]).values(), mode));
}
