const cycle: any[] = ['cycle'];
cycle.push(cycle);
const left: any[] = ['left'];
const right: any[] = ['right', left];
left.push(right);
const shared: any[] = [1, 2];
const entries: any[] = [
  [], [1, 2], ['a', null, false], [[1, 2], 3], cycle, left, shared, shared,
];
for (let round = 0; round < 4; round++) {
  for (let index = 0; index < entries.length; index++) {
    const raw: any[] = ['x', entries[index], 'y'];
    try { console.log(round, index, (raw as string[]).join('|')); }
    catch (error) { console.log(round, index, 'caught', error instanceof TypeError); }
  }
}
