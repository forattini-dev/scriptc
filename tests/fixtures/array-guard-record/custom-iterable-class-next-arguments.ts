class CountIterator {
  index: number = 0; count: number; trace: string[];
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  next(...args: any[]): any {
    this.trace.push('args:' + args.length);
    this.index++;
    return { done: this.index > this.count, value: this.index };
  }
  return(): any { this.trace.push('return'); return { done: true }; }
}
class CountSource {
  trace: string[]; count: number;
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  [Symbol.iterator](): any { return new CountIterator(this.trace, this.count); }
}
for (let count = 0; count < 4; count++) for (let stop = 0; stop < 2; stop++) for (let round = 0; round < 4; round++) {
  const trace: string[] = [];
  for (const x of new CountSource(trace, count) as any) { trace.push('v:' + x); if (stop) break; }
  console.log(count, stop, round, trace.join(','));
}
