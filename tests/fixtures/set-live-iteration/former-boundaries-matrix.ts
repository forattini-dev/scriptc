for (let round = 0; round < 8; round++) for (let mode = 0; mode < 4; mode++) {
  if (mode === 0) { const set = new Set<unknown>(['a', ...new Set(['b'])]); console.log(round, mode, set.size, set.has('b')); }
  if (mode === 1) { const seed: unknown[] = ['a']; const set = new Set<unknown>(seed); console.log(round, mode, set.size, set.has('a')); }
  if (mode === 2) { const set = new Set<unknown>(['a']); const value: unknown = set; console.log(round, mode, value === set, set.size); }
  if (mode === 3) { const set = new Set<unknown>(['a']); const value: any = { set }; console.log(round, mode, value.set === set, value.set.size); }
}
