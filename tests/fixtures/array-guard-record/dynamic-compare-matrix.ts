const values: any[] = [
  {},
  { valueOf() { return 2; } },
  { toString() { return '10'; } },
  { valueOf() { return '2'; } },
  { [Symbol.toPrimitive](hint: string) { return hint === 'number' ? 3 : 8; } },
  { valueOf() { return {}; }, toString() { return '4'; } },
  { valueOf() { throw new Error('valueOf'); } },
  { valueOf() { return {}; }, toString() { return {}; } },
];
function compare(value: any, mode: number) {
  if (mode === 0) return value < '3';
  if (mode === 1) return value <= '3';
  if (mode === 2) return value > '3';
  return value >= '3';
}
for (let i = 0; i < values.length; i++) {
  for (let mode = 0; mode < 4; mode++) {
    try { console.log(i, mode, compare(values[i], mode)); }
    catch (error) { console.log(i, mode, 'caught', error instanceof TypeError, error instanceof Error); }
  }
}
