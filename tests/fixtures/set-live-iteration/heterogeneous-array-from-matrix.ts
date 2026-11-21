function valueFor(mode: number): any {
  if (mode === 0) return '1'; if (mode === 1) return undefined; if (mode === 2) return null; if (mode === 3) return false;
  if (mode === 4) return NaN; if (mode === 5) return -0; if (mode === 6) return { n: 4 }; return Symbol('key');
}
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 4; action++) {
  const key: any = valueFor(mode);
  try {
    const set = new Set<number>([1, key]);
    const arr: any = Array.from(set);
    let result: string;
    if (action === 0) result = 'length:' + arr.length;
    else if (action === 1) result = 'secondType:' + typeof arr[1];
    else if (action === 2) result = 'secondIdentity:' + (arr[1] === key || (Number.isNaN(arr[1]) && Number.isNaN(key)));
    else { const values: string[] = []; for (const value of arr) values.push(typeof value); result = 'values:' + values.join(','); }
    console.log(mode, action, result);
  } catch (e) { console.log(mode, action, e instanceof TypeError ? 'TypeError' : 'other'); }
}
