function* source(trace: string[], mode: number): Generator<number, void, undefined> {
  try { trace.push('start'); yield 1; trace.push('resume'); yield 2; }
  finally { trace.push('finally'); if (mode >= 4) throw new Error('cleanup'); }
}
function step(trace: string[], value: number, mode: number): void {
  trace.push('call:' + value);
  if (mode % 4 === 0 && value === 1) throw new Error('first');
  if (mode % 4 === 1 && value === 2) throw new Error('second');
}
function consume(values: Iterable<number>, trace: string[], mode: number): void {
  for (const value of values) { step(trace, value, mode); if (mode % 4 === 3) break; }
}
consume(new Map<string, number>().values(), [], -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  const trace: string[] = [];
  try { consume(source(trace, mode), trace, mode); trace.push('done'); }
  catch (error) { trace.push('caught:' + (error as Error).message); }
  console.log(round, mode, trace.join(','));
}
