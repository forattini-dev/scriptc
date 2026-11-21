function* values(trace: string[]): Generator<number, void, undefined> { try { yield 7; yield 8; } finally { trace.push('close'); } }
class DirectIterable {
  trace: string[];
  constructor(trace: string[]) { this.trace = trace; }
  [Symbol.iterator](): Generator<number, void, undefined> { this.trace.push('iterator'); return values(this.trace); }
}
const trace: string[] = [];
for (const value of new DirectIterable(trace)) { trace.push('value:' + value); break; }
console.log(trace.join(','));
