function* source(trace: string[]): Generator<number, void, undefined> {
  try { trace.push('start'); yield 1; trace.push('resume'); yield 2; }
  finally { trace.push('iterator-finally'); }
}
function fail(): void { throw new Error('inner'); }
function consume(values: Iterable<number>, trace: string[], mode: number): string {
  for (const value of values) {
    trace.push('value:' + value);
    if (mode === 0) { try { throw new Error('inner'); } catch { trace.push('caught-inner'); } }
    if (mode === 1) { try { fail(); } catch { trace.push('caught-call'); } }
    if (mode === 2) { try { throw new Error('inner'); } finally { trace.push('body-finally'); } }
    if (mode === 3) { try { break; } finally { trace.push('body-finally'); } }
    if (mode === 4) { try { return 'early'; } finally { trace.push('body-finally'); } }
    if (mode === 5) { for (let n = 0; n < 2; n++) { trace.push('inner:' + n); break; } }
    if (mode === 6 && value === 1) { try { continue; } finally { trace.push('body-finally'); } }
    if (mode === 7 && value === 2) { try { fail(); } finally { trace.push('body-finally'); } }
  }
  return 'done';
}
consume(new Map<string, number>().values(), [], -1);
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  const trace: string[] = [];
  try { trace.push('result:' + consume(source(trace), trace, mode)); }
  catch (error) { trace.push('caught:' + (error as Error).message); }
  console.log(round, mode, trace.join(','));
}
