class Iter {
  i: number = 0; count: number; trace: string[];
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  next(): any { this.trace.push('next'); this.i++; return { done: this.i > this.count, value: this.i }; }
  return(): any { this.trace.push('return'); return { done: true }; }
}
class Source {
  trace: string[]; count: number;
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  [Symbol.iterator](): any { this.trace.push('iterator'); return new Iter(this.trace, this.count); }
}
function consume(value: any, action: number, trace: string[]): number {
  for (const v of value) {
    trace.push('v:' + v);
    if (action === 1) break;
    if (action === 2) return 7;
    if (action === 3) throw new Error('body');
  }
  return 0;
}
for (let count = 0; count < 4; count++) for (let action = 0; action < 4; action++) for (let round = 0; round < 2; round++) {
  const trace: string[] = [];
  try { trace.push('result:' + consume(new Source(trace, count), action, trace)); }
  catch (e) { trace.push('error:' + (e as Error).message); }
  console.log(count, action, round, trace.join(','));
}
