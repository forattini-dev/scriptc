class ParentIterator {
  index: number = 0; trace: string[]; mode: number;
  constructor(trace: string[], mode: number) { this.trace = trace; this.mode = mode; }
  get next(): () => any {
    this.trace.push('get-next');
    if (this.mode === 2) throw new Error('getter');
    return () => {
      this.trace.push('next');
      if (this.mode === 3) throw new Error('step');
      this.index++;
      if (this.mode === 4 || this.index > 2) return { done: true };
      return { done: false, value: this.mode === 5 ? 'text' : this.index };
    };
  }
  return(): any { this.trace.push('return'); return { done: true }; }
}
class ChildIterator extends ParentIterator {}
class ChildSource {
  trace: string[]; mode: number;
  constructor(trace: string[], mode: number) { this.trace = trace; this.mode = mode; }
  [Symbol.iterator](): any { this.trace.push('iterator'); return new ChildIterator(this.trace, this.mode); }
}
function consume(source: any, trace: string[], mode: number): number {
  for (const x of source) {
    trace.push('value:' + x);
    if (mode === 6) return 9;
    if (mode === 7) throw new Error('body');
  }
  return 0;
}
for (let mode = 0; mode < 8; mode++) for (let round = 0; round < 4; round++) {
  const trace: string[] = [];
  try { trace.push('result:' + consume(new ChildSource(trace, mode), trace, mode)); }
  catch (e) { trace.push('error:' + (e as Error).message); }
  console.log(mode, round, trace.join(','));
}
