for (let length = 0; length < 8; length++) for (let action = 0; action < 4; action++) {
  const source: number[] = [1, 2, 3]; source.length = length;
  try {
    const set = new Set<number>(source);
    let result: string;
    if (action === 0) result = 'size:' + set.size;
    else if (action === 1) result = 'hasUndefined:' + set.has(undefined as any);
    else if (action === 2) result = 'deleteUndefined:' + set.delete(undefined as any) + ':' + set.size;
    else { const values: string[] = []; for (const value of set) values.push(typeof value + ':' + String(value)); result = 'values:' + values.join(','); }
    console.log(length, action, result);
  } catch (e) { console.log(length, action, e instanceof TypeError ? 'TypeError' : 'other'); }
}
