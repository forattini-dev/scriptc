function collect(values: Iterable<any>): string {
  const out: string[] = [];
  for (const value of values) {
    out.push(typeof value + ':' + (value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'object' ? 'object' : String(value)));
  }
  return out.join('|');
}
function* source(mode: number): Generator<any, void, undefined> {
  if (mode === 0) { yield 1; yield 2; }
  if (mode === 1) yield undefined;
  if (mode === 2) yield null;
  if (mode === 3) yield 'eight';
  if (mode === 4) yield false;
  if (mode === 5) yield { x: 1 };
  if (mode === 6) { yield 3; yield 'four'; yield undefined; }
}
collect(new Map<string, any>([['seed', 0]]).values());
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  console.log(round, mode, collect(source(mode)));
}
