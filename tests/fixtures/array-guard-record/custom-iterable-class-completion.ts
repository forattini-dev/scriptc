function* items(trace: string[], count: number): Generator<number, void, undefined> {
  try { trace.push('start'); for (let i = 0; i < count; i++) yield i + 1; }
  finally { trace.push('close'); }
}
class Both {
  trace: string[]; count: number;
  constructor(trace: string[], count: number) { this.trace = trace; this.count = count; }
  next(): any { this.trace.push('wrong-next'); return { done: true }; }
  [Symbol.iterator](): Generator<number, void, undefined> { this.trace.push('iterator'); return items(this.trace, this.count); }
}
function consume(value: any, action: number, trace: string[]): number {
  for (const item of value) {
    trace.push('item:' + item);
    if (action === 1) break;
    if (action === 2) return 9;
    if (action === 3) throw new Error('body');
  }
  return 0;
}
for (let count = 0; count < 4; count++) for (let action = 0; action < 4; action++) for (let cast = 0; cast < 2; cast++) {
  const trace: string[] = [];
  const source = new Both(trace, count);
  try { const result = cast ? consume(source, action, trace) : consume(source as any, action, trace); trace.push('result:' + result); }
  catch (e) { trace.push('error:' + (e as Error).message); }
  console.log(count, action, cast, trace.join(','));
}
