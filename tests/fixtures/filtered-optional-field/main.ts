type Row = { number: number; error?: string };

function project(rows: Row[]) {
  return rows.filter(row => row.error).map(row => [row.number, { error: row.error! }] as const);
}

const simple: Row[] = [{ number: 1, error: 'one' }, { number: 2 }, { number: 3, error: '' }];
console.log(JSON.stringify(project(simple)));

let reads = 0;
const changing: Row = {
  number: 4,
  get error() { return ++reads === 1 ? 'first' : undefined; },
};
const getterResult = project([changing]);
console.log(JSON.stringify(getterResult));
console.log(Object.keys(getterResult[0][1]).join(','), typeof getterResult[0][1].error, reads);
console.log(getterResult[0][1].error + ':suffix');
console.log(String(getterResult[0][1].error));
console.log(`value=${getterResult[0][1].error}`);
console.log(getterResult[0][1].error ?? 'fallback');
console.log(getterResult[0][1].error === undefined);
console.log(Boolean(getterResult[0][1].error));
console.log(Number(getterResult[0][1].error));

const mutable: Row = { number: 5, error: 'before' };
const mutated = [mutable]
  .filter(row => { const keep = !!row.error; row.error = undefined; return keep; })
  .map(row => ({ error: row.error! }));
console.log(JSON.stringify(mutated), Object.keys(mutated[0]).join(','), typeof mutated[0].error);

const keyed = new Map<number, { [key: string]: unknown }>(project(simple));
console.log(JSON.stringify(keyed.get(1)), keyed.has(2), keyed.size);
