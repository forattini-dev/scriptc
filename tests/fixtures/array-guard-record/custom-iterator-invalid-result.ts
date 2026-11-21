class InvalidIterator {
  mode: number; constructor(mode: number) { this.mode = mode; }
  next(): any {
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
class InvalidSource {
  mode: number; constructor(mode: number) { this.mode = mode; }
  [Symbol.iterator](): any { return new InvalidIterator(this.mode); }
}
for (let mode = 0; mode < 8; mode++) for (let round = 0; round < 4; round++) {
  const trace: string[] = [];
  try { for (const x of new InvalidSource(mode) as any) { trace.push('yield:' + String(x)); break; } trace.push('done'); }
  catch (e) { trace.push(e instanceof TypeError ? 'TypeError' : 'other'); }
  console.log(mode, round, trace.join(','));
}
