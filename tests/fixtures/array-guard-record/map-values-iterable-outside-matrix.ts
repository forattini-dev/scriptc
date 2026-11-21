function observe(values: Iterable<number>): string {
  for (const value of values) return typeof value + ':' + (value === null ? 'null' : value === undefined ? 'undefined' : 'present');
  return 'empty';
}
const items: any[] = [undefined, null, false, 0, 2.5, '8', { name: 'x' }, [1, 2]];
for (let round = 0; round < 4; round++) {
  for (let mode = 0; mode < 8; mode++) {
    const map = new Map<string, any>();
    map.set('value', items[mode]);
    console.log(round, mode, observe(map.values()));
  }
}
