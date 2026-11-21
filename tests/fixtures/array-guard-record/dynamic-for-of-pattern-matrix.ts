function* pairs(mode: number): Generator<any, void, undefined> {
  if (mode === 0) { yield [1, 2]; yield [3, 4]; }
  else { yield [undefined, 'x']; yield [0, null]; }
}
function* objects(mode: number): Generator<any, void, undefined> {
  if (mode === 0) { yield { a: 1, b: 2 }; yield { a: 3, b: 4 }; }
  else { yield { a: undefined, b: 'x' }; yield { a: 0, b: null }; }
}
function pairValues(values: any): string {
  const out: string[] = [];
  for (const [a, b] of values) out.push(String(a) + ':' + String(b));
  return out.join('|');
}
function objectValues(values: any): string {
  const out: string[] = [];
  for (const { a, b } of values) out.push(String(a) + ':' + String(b));
  return out.join('|');
}
for (let round = 0; round < 4; round++) for (let mode = 0; mode < 8; mode++) {
  let result = '';
  if (mode === 0) result = pairValues(pairs(0));
  if (mode === 1) result = objectValues(objects(0));
  if (mode === 2) result = pairValues(pairs(1));
  if (mode === 3) result = objectValues(objects(1));
  if (mode === 4) result = pairValues(new Map<string, any>([['x', [1, 2]], ['y', [3, 4]]]).values());
  if (mode === 5) result = objectValues(new Map<string, any>([['x', { a: 1, b: 2 }], ['y', { a: 3, b: 4 }]]).values());
  if (mode === 6) result = pairValues([[1, 2], [3, 4]]);
  if (mode === 7) result = objectValues([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  console.log(round, mode, result);
}
