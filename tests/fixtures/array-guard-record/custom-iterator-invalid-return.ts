class ClosingIterator {
  mode: number; constructor(mode: number) { this.mode = mode; }
  next(): any { return { done: false, value: 1 }; }
  return(): any {
    if (this.mode === 0) return undefined;
    if (this.mode === 1) return null;
    if (this.mode === 2) return 0;
    if (this.mode === 3) return 3;
    if (this.mode === 4) return false;
    if (this.mode === 5) return true;
    if (this.mode === 6) return 'x';
    return 0n;
  }
}
class ClosingSource {
  mode: number; constructor(mode: number) { this.mode = mode; }
  [Symbol.iterator](): any { return new ClosingIterator(this.mode); }
}
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 2; action++) for (let round = 0; round < 2; round++) {
  const trace: string[] = [];
  try { for (const x of new ClosingSource(mode) as any) { trace.push('value:' + x); if (action) throw new Error('body'); break; } trace.push('done'); }
  catch (e) { trace.push(e instanceof TypeError ? 'TypeError' : 'error:' + (e as Error).message); }
  console.log(mode, action, round, trace.join(','));
}
