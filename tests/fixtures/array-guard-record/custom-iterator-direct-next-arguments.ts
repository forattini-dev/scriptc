class ArgIterator {
  trace: string[]; constructor(trace: string[]) { this.trace = trace; }
  next(...args: any[]): any { this.trace.push('args:' + args.length); return { value: 1, done: false }; }
}
function retain(value: Iterator<number, void, undefined>): any { return value; }
for (let mode = 0; mode < 4; mode++) for (let round = 0; round < 8; round++) {
  const trace: string[] = [];
  const value: any = retain(new ArgIterator(trace) as any);
  if (mode === 0) value.next();
  if (mode === 1) value.next(undefined);
  if (mode === 2) { value.next(); value.next(undefined); }
  if (mode === 3) { value.next(undefined); value.next(); }
  console.log(mode, round, trace.join(','));
}
