const keys: any[] = [0, -0, NaN, 1, '1', null, undefined, false, {}, Infinity];
for (let i = 0; i < keys.length; i++) {
  for (let mode = 0; mode < 4; mode++) {
    const map = new Map<number, string>();
    map.set(0, 'zero');
    map.set(NaN, 'nan');
    map.set(1, 'one');
    try {
      if (mode === 0) console.log(i, mode, JSON.stringify(map.get(keys[i] as number)));
      else if (mode === 1) console.log(i, mode, map.has(keys[i] as number));
      else if (mode === 2) console.log(i, mode, map.delete(keys[i] as number), map.size);
      else console.log(i, mode, JSON.stringify(map.get(keys[i] as number)), map.has(keys[i] as number));
    } catch (error) { console.log(i, mode, 'caught', error instanceof TypeError); }
  }
}
