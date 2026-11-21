function* numbers(): Generator<any, void, undefined> { yield 1; yield 2; }
function* mixed(): Generator<any, void, undefined> { yield 'x'; yield null; }
function* empty(): Generator<any, void, undefined> { }
function select(mode: number): any {
  if (mode === 0) return numbers();
  if (mode === 1) return mixed();
  if (mode === 2) return empty();
  if (mode === 3) return new Map<string, number>([['a', 3], ['b', 4]]).values();
  if (mode === 4) return [1, 2];
  if (mode === 5) { const a: any[] = [1, 2]; delete a[0]; return a; }
  if (mode === 6) return 'a😀';
  return '';
}
function consume(values: any): string {
  const out: string[] = [];
  for (const value of values) out.push(typeof value + ':' + (value === null ? 'null' : value === undefined ? 'undefined' : String(value)));
  return out.join('|');
}
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  try { console.log(round, mode, consume(select(mode))); }
  catch (error) { console.log(round, mode, 'caught:' + (error as Error).message); }
}
