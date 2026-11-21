function* source(trace: string[], name: string): Generator<number, void, undefined> {
  try { trace.push(name + ':start'); yield 1; trace.push(name + ':resume'); yield 2; }
  finally { trace.push(name + ':finally'); }
}
function consume(outer: Iterable<number>, trace: string[], mode: number): string {
  for (const x of outer) {
    trace.push('outer:' + x);
    for (const y of source(trace, 'inner')) {
      trace.push('inner:' + y);
      if (mode === 1) break;
      if (mode === 3) return 'early';
      if (mode === 4) throw new Error('explicit');
      if (mode === 5 && y === 1) continue;
      if (mode === 6) { try { break; } finally { trace.push('body-finally'); } }
      if (mode === 7 && y === 2) throw new Error('late');
    }
    if (mode === 2) break;
  }
  return 'done';
}
consume(new Map<string, number>().values(), [], -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  const trace: string[] = [];
  try { trace.push('result:' + consume(source(trace, 'outer'), trace, mode)); }
  catch (error) { trace.push('caught:' + (error as Error).message); }
  console.log(round, mode, trace.join(','));
}
