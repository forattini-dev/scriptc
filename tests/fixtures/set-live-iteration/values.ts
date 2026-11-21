const first = { id: 1 };
const second = { id: 2 };
const typed = new Set([first, second]);
for (const value of typed) {
  console.log('typed', value === first, value === second, value.id);
  value.id++;
}
console.log('changed', first.id, second.id);

const dynamic = new Set<any>([first, undefined, null, false, NaN, -0]);
for (const value of dynamic) {
  console.log('dynamic', value === first, value === undefined, value === null,
    value === false, typeof value, Object.is(value, NaN), Object.is(value, 0));
}

const empty = new Set<number>();
let emptyCount = 0;
for (const value of empty) { emptyCount += value; }
console.log('empty', emptyCount);
