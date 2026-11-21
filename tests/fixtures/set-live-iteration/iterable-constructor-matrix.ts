function* generated(): Generator<any, void, undefined> { yield 1; yield '1'; yield 2; yield 1; }
class CustomSource { [Symbol.iterator](): Generator<any, void, undefined> { return generated(); } }
function source(mode: number): any {
  if (mode === 0) return undefined;
  if (mode === 1) return null;
  if (mode === 2) return [1, 2, 1];
  if (mode === 3) return [1, '1', undefined, 1];
  if (mode === 4) return generated();
  if (mode === 5) return new CustomSource();
  if (mode === 6) return new Set<number>([1, 2, 1]);
  if (mode === 7) return '1😀1';
  return 7;
}
for (let mode = 0; mode < 9; mode++) for (let action = 0; action < 4; action++) {
  try {
    const set = new Set<number>(source(mode));
    const key: any = mode === 3 || mode === 4 || mode === 5 || mode === 7 ? '1' : 1;
    let result: string;
    if (action === 0) result = 'size:' + set.size;
    else if (action === 1) result = 'has:' + set.has(key);
    else if (action === 2) result = 'delete:' + set.delete(key) + ':' + set.size;
    else { const values: string[] = []; for (const value of set) values.push(typeof value + ':' + String(value)); result = 'values:' + values.join(','); }
    console.log(mode, action, result);
  } catch (e) { console.log(mode, action, e instanceof TypeError ? 'TypeError' : 'other'); }
}
