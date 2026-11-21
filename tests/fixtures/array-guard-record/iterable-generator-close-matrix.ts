function* source(trace: string[]): Generator<number, void, undefined> {
  try {
    trace.push('start');
    yield 1;
    trace.push('resume');
    yield 2;
    trace.push('end');
  } finally { trace.push('finally'); }
}
function consume(values: Iterable<number>, trace: string[], mode: number): string {
  for (const value of values) {
    trace.push('value:' + value);
    if (mode === 1) break;
    if (mode === 2) throw new Error('stop');
    if (mode === 3) return 'early';
    if (mode === 4) continue;
    if (mode === 5 && value === 2) break;
    if (mode === 6 && value === 1) continue;
    if (mode === 7 && value === 2) throw new Error('late');
  }
  return 'done';
}
consume(new Map<string, number>([['seed', 0]]).values(), [], -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  const trace: string[] = [];
  try { trace.push('result:' + consume(source(trace), trace, mode)); }
  catch (error) { trace.push('caught:' + (error as Error).message); }
  console.log(round, mode, trace.join(','));
}
