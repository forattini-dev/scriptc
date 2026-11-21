function* source(trace: string[]): Generator<number, void, undefined> { try { trace.push('start'); yield 5; yield 6; } finally { trace.push('close'); } }
class GetterIterable {
  trace: string[];
  constructor(trace: string[]) { this.trace = trace; }
  get [Symbol.iterator](): () => Generator<number, void, undefined> {
    this.trace.push('get');
    return () => { this.trace.push('call'); return source(this.trace); };
  }
}
for (let n = 0; n < 32; n++) {
  const trace: string[] = [];
  const sourceValue: any = new GetterIterable(trace);
  for (const v of sourceValue) { trace.push('value:' + v); if ((n & 1) === 0) break; }
  console.log(n, trace.join(','));
}
