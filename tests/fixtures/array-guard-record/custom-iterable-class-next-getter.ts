class IteratorWithGetter {
  i: number = 0; count: number; trace: string[];
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  get next(): () => any { this.trace.push('getnext'); return () => { this.trace.push('next'); this.i++; return { done: this.i > this.count, value: this.i }; }; }
  return(): any { this.trace.push('return'); return { done: true }; }
}
class SourceGetter {
  trace: string[]; count: number;
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  [Symbol.iterator](): any { this.trace.push('iterator'); return new IteratorWithGetter(this.trace, this.count); }
}
for (let count = 0; count < 4; count++) for (let stop = 0; stop < 2; stop++) for (let round = 0; round < 4; round++) {
  const trace: string[] = [];
  try { for (const x of new SourceGetter(trace, count) as any) { trace.push('v:' + x); if (stop) break; } }
  catch (e) { trace.push('error:' + (e as Error).message); }
  console.log(count, stop, round, trace.join(','));
}
