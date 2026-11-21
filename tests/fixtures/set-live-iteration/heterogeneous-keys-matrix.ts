function valueFor(mode: number): any {
  if (mode === 0) return '1';
  if (mode === 1) return undefined;
  if (mode === 2) return null;
  if (mode === 3) return false;
  if (mode === 4) return NaN;
  if (mode === 5) return -0;
  if (mode === 6) return { n: 4 };
  return Symbol('key');
}
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 4; action++) {
  const key: any = valueFor(mode);
  const set = new Set<number>([1]);
  const returned = set.add(key);
  const had = set.has(key);
  let outcome: any;
  if (action === 0) outcome = had;
  else if (action === 1) outcome = set.size;
  else if (action === 2) { outcome = set.delete(key); outcome = String(outcome) + ':' + String(set.has(key)) + ':' + String(set.size); }
  else outcome = returned === set;
  console.log(mode, action, String(outcome));
}
