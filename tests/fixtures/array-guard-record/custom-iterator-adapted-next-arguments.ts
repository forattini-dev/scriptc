class DirectIterator {
  trace: string[]; constructor(trace: string[]) { this.trace = trace; }
  next(...args: any[]): any { this.trace.push('args:' + args.length); return { done: false, value: 1 }; }
}
function inspect(value: Generator<any, void, undefined>, mode: number): void {
  const v: any = value;
  if (mode === 0) v.next();
  if (mode === 1) v.next(undefined);
  if (mode === 2) { v.next(); v.next(undefined); }
  if (mode === 3) { v.next(undefined); v.next(); }
}
for (let mode = 0; mode < 4; mode++) for (let round = 0; round < 8; round++) {
  const trace: string[] = [];
  inspect(new DirectIterator(trace) as any, mode);
  console.log(mode, round, trace.join(','));
}
