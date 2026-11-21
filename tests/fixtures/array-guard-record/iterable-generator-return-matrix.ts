function* source(mode: number): Generator<number, void, undefined> {
  try { yield 1; yield 2; }
  finally { if (mode === 4) return; if (mode === 5) yield 9; }
}
function observe(g: any, mode: number): string {
  if (mode === -1) return 'seed';
  if (mode === 0) { const v = g.return(99); return typeof v.value + ':' + String(v.value) + ':' + v.done; }
  if (mode === 1) { g.next(); const v = g.return(99); return typeof v.value + ':' + String(v.value) + ':' + v.done; }
  if (mode === 2) { g.next(); g.next(); g.next(); const v = g.return(99); return typeof v.value + ':' + String(v.value) + ':' + v.done; }
  if (mode === 3) { g.next(); const v = g.return(); return typeof v.value + ':' + String(v.value) + ':' + v.done; }
  if (mode === 4) { g.next(); const v = g.return(99); return typeof v.value + ':' + String(v.value) + ':' + v.done; }
  if (mode === 5) { g.next(); const a = g.return(99); const b = g.next(); return String(a.value) + ':' + a.done + ',' + String(b.value) + ':' + b.done; }
  if (mode === 6) { g.next(); try { g.throw('sentinel'); } catch (error) { return String(error); } }
  if (mode === 7) { const next = g.next; try { next.call({}); } catch (error) { return String(error instanceof TypeError); } }
  return 'unknown';
}
observe(new Map<string, number>().values(), -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) console.log(round, mode, observe(source(mode), mode));
