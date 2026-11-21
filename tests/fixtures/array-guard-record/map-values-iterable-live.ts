function collect(values: Iterable<number>, map: Map<string, number>, mode: number): string {
  const out: string[] = [];
  for (const value of values) {
    out.push(String(value));
    if (out.length === 1) {
      if (mode === 1) map.delete('b');
      if (mode === 2) map.set('c', 3);
      if (mode === 3) map.clear();
      if (mode === 4) { map.clear(); map.set('c', 3); }
      if (mode === 5) { map.delete('a'); map.set('a', 4); }
      if (mode === 6) map.set('b', 8);
      if (mode === 7) { map.delete('b'); map.set('b', 9); }
    }
  }
  return out.join(',');
}
for (let round = 0; round < 4; round++) {
  for (let mode = 0; mode < 8; mode++) {
    const map = new Map<string, number>([['a', 1], ['b', 2]]);
    console.log(round, mode, collect(map.values(), map, mode));
  }
}
