const values: any[] = [
  { valueOf() { return 10n; } },
  { toString() { return '10'; } },
  { valueOf() { return 'not-a-number'; } },
  { valueOf() { return Symbol('s'); } },
];
const other: any[] = [3n, '11', null, 1];
for (let i = 0; i < values.length; i++) {
  for (let j = 0; j < other.length; j++) {
    for (let mode = 0; mode < 4; mode++) {
      try {
        const a = values[i], b = other[j];
        const result = mode === 0 ? a < b : mode === 1 ? a <= b : mode === 2 ? a > b : a >= b;
        console.log(i, j, mode, result);
      } catch (error) { console.log(i, j, mode, 'caught', error instanceof TypeError); }
    }
  }
}
