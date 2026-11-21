function* source(trace: string[], mode: number): Generator<number, void, undefined> {
  try { trace.push('start'); yield 1; yield 2; }
  finally { trace.push('iterator-finally'); if (mode === 5 || mode === 7) throw new Error('iterator-error'); }
}
function consume(values: Iterable<number>, trace: string[], mode: number): string {
  for (const value of values) {
    trace.push('value:' + value);
    try {
      if (mode % 4 === 0) break;
      if (mode % 4 === 1) return 'early';
      if (mode % 4 === 2) throw new Error('body-error');
      continue;
    } finally {
      trace.push('body-finally');
      if (mode >= 4) throw new Error('finally-error');
    }
  }
  return 'done';
}
consume(new Map<string, number>().values(), [], -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  const trace: string[] = [];
  try { trace.push('result:' + consume(source(trace, mode), trace, mode)); }
  catch (error) { trace.push('caught:' + (error as Error).message); }
  console.log(round, mode, trace.join(','));
}
