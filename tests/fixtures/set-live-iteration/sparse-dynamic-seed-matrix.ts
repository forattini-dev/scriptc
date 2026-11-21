function arrayFor(mode: number): any[] {
  const value: any[] = [1, 2, 3];
  if (mode === 0) delete (value as any)[0];
  if (mode === 1) delete (value as any)[1];
  if (mode === 2) delete (value as any)[2];
  if (mode === 3) { delete (value as any)[0]; delete (value as any)[2]; }
  if (mode === 4) (value as any)[1] = undefined;
  if (mode === 5) (value as any)[1] = '2';
  if (mode === 6) value.length = 5;
  if (mode === 7) (value as any)[0] = null;
  return value;
}
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 4; action++) {
  const source = arrayFor(mode);
  try {
    const set = new Set<number>(source);
    let result: string;
    if (action === 0) result = 'size:' + set.size;
    else if (action === 1) result = 'hasUndefined:' + set.has(undefined as any);
    else if (action === 2) result = 'deleteUndefined:' + set.delete(undefined as any) + ':' + set.size;
    else { const values: string[] = []; for (const value of set) values.push(typeof value + ':' + String(value)); result = 'values:' + values.join(','); }
    console.log(mode, action, result);
  } catch (e) { console.log(mode, action, e instanceof TypeError ? 'TypeError' : 'other'); }
}

