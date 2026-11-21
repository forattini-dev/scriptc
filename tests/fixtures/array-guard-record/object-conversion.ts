const objects: any[] = [
  {},
  { toString() { return 'custom'; } },
  { toString() { return 7; } },
  { toString() { return null; } },
  { toString() { return {}; }, valueOf() { return 'fallback'; } },
  { toString: 42, valueOf() { return 'second'; } },
  { [Symbol.toPrimitive](hint: string) { return `hint:${hint}`; } },
  { toString() { throw new TypeError('custom failure'); } },
];
for (let round = 0; round < 4; round++) {
  for (let index = 0; index < objects.length; index++) {
    const raw: any[] = ['x', objects[index]];
    const view = raw as string[];
    try { console.log(round, index, view.join('|')); }
    catch (error) { console.log(round, index, 'caught', error instanceof TypeError); }
  }
}
