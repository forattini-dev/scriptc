const keys: any[] = ['name', '1', 1, null, undefined, false, {}, 'missing'];
for (let i = 0; i < keys.length; i++) {
  for (let mode = 0; mode < 4; mode++) {
    const map = new Map<string, string>();
    map.set('name', 'present');
    map.set('1', 'one');
    try {
      if (mode === 0) console.log(i, mode, JSON.stringify(map.get(keys[i] as string)));
      else if (mode === 1) console.log(i, mode, map.has(keys[i] as string));
      else if (mode === 2) console.log(i, mode, map.delete(keys[i] as string), map.size);
      else console.log(i, mode, JSON.stringify(map.get(keys[i] as string)), map.has(keys[i] as string));
    } catch (error) { console.log(i, mode, 'caught', error instanceof TypeError); }
  }
}
