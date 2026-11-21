function valueFor(mode: number): any {
  if (mode === 0) return '1'; if (mode === 1) return undefined; if (mode === 2) return null; if (mode === 3) return false;
  if (mode === 4) return NaN; if (mode === 5) return -0; if (mode === 6) return { n: 4 }; return Symbol('key');
}
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 4; action++) {
  const key: any = valueFor(mode);
  try {
    const set = new Set<number>([1, key, key]);
    let outcome: string;
    if (action === 0) outcome = 'has:' + set.has(key);
    else if (action === 1) outcome = 'size:' + set.size;
    else if (action === 2) outcome = 'delete:' + set.delete(key) + ':' + set.size;
    else { const values: string[] = []; for (const value of set) values.push(typeof value); outcome = 'values:' + values.join(','); }
    console.log(mode, action, outcome);
  } catch (e) { console.log(mode, action, e instanceof TypeError ? 'TypeError' : 'other'); }
}
