function observe(it: any, mode: number): string {
  if (mode === 0) return String(typeof it);
  if (mode === 1) return String(typeof it.next);
  if (mode === 2) return String(typeof it.return);
  if (mode === 3) return String(it[Symbol.iterator]() === it);
  if (mode === 4) return String(it.next().value);
  if (mode === 5) { const alias = it; return String(alias === it); }
  if (mode === 6) { it.next(); it.next(); return String(it.next().done); }
  if (mode === 7) { it.next(); it.next(); it.next(); return String(it.next().value); }
  return 'unreachable';
}
for (let round = 0; round < 4; round++) {
  for (let mode = 0; mode < 8; mode++) {
    console.log(round, mode, observe(new Map<string, number>([['a', 1], ['b', 2]]).values(), mode));
  }
}
