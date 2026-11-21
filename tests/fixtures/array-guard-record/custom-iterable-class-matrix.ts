function* source(mode: number, trace: string[]): Generator<any, void, undefined> {
  try {
    trace.push('start');
    if (mode === 0) { yield 1; yield 2; }
    if (mode === 1) yield undefined;
    if (mode === 2) yield null;
    if (mode === 3) yield 'x';
    if (mode === 4) yield false;
    if (mode === 5) { yield 3; yield 'y'; }
    if (mode >= 6) { yield 1; yield 2; }
  } finally { trace.push('finally'); }
}
class CustomIterable {
  readonly mode: number; readonly trace: string[];
  constructor(mode: number, trace: string[]) { this.mode = mode; this.trace = trace; }
  [Symbol.iterator](): Generator<any, void, undefined> { this.trace.push('iterator'); return source(this.mode, this.trace); }
}
function consume(values: any, mode: number, trace: string[]): void {
  for (const value of values) {
    trace.push(typeof value + ':' + (value === null ? 'null' : value === undefined ? 'undefined' : String(value)));
    if (mode === 6) break;
    if (mode === 7) throw new Error('body');
  }
}
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  const trace: string[] = [];
  try { consume(new CustomIterable(mode, trace), mode, trace); trace.push('done'); }
  catch (error) { trace.push('caught:' + (error as Error).message); }
  console.log(round, mode, trace.join(','));
}
