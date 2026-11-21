function* source(): Generator<number, void, undefined> { yield 1; yield 2; }
function observe(g: any, mode: number): string {
  if (mode === -1) return 'seed';
  if (mode === 0) return typeof g.next;
  if (mode === 1) return typeof g.return;
  if (mode === 2) return typeof g.throw;
  if (mode === 3) return String(g[Symbol.iterator]() === g);
  if (mode === 4) return String(g.next().value);
  if (mode === 5) { g.next(); g.next(); return String(g.next().done); }
  if (mode === 6) { const next = g.next; try { next.call({}); } catch (error) { return String(error instanceof TypeError); } }
  if (mode === 7) { g.next(); const result = g.return(99); return typeof result.value + ':' + String(result.value) + ':' + result.done; }
  return 'unknown';
}
observe(new Map<string, number>().values(), -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  console.log(round, mode, observe(source(), mode));
}
