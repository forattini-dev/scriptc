class CustomIterator {
  index: number = 0; mode: number; trace: string[];
  constructor(mode: number, trace: string[]) { this.mode = mode; this.trace = trace; }
  get next(): () => any {
    this.trace.push('get-next');
    if (this.mode === 2) throw new Error('getter');
    return () => {
      this.trace.push('next');
      if (this.mode === 3) throw new Error('step');
      if (this.mode === 4) return 7;
      this.index++;
      if (this.mode === 1 || this.index > 2) return { done: true };
      return { done: false, value: this.mode === 5 ? 1 : this.mode === 6 ? 'x' : this.index };
    };
  }
  return(): any { this.trace.push('return'); return { done: true }; }
}
class CustomSource {
  mode: number; trace: string[];
  constructor(mode: number, trace: string[]) { this.mode = mode; this.trace = trace; }
  next(): any { this.trace.push('wrong-next'); return { done: true }; }
  [Symbol.iterator](): any { this.trace.push('iterator'); return new CustomIterator(this.mode, this.trace); }
}
for (let mode = 0; mode < 8; mode++) for (let round = 0; round < 4; round++) {
  const trace: string[] = [];
  try {
    const set = new Set<number>(new CustomSource(mode, trace) as any);
    const result: string[] = []; for (const item of set) result.push(typeof item + ':' + String(item));
    console.log(mode, round, 'ok:' + result.join('|'), trace.join(','));
  } catch (e) { console.log(mode, round, e instanceof TypeError ? 'TypeError' : (e as Error).message, trace.join(',')); }
}
