// The static/island boundary: a static loop calling an island function
// that answers a record, exiting through the validated JSON boundary.
import { makeRow, sumRows } from "./rows.ts";

const N = 20000;
const started = performance.now();
let total = 0;
for (let i = 0; i < N; i++) {
  const row = makeRow(i);
  total += row.value + row.tags.length;
}
const echoed = sumRows(Array.from({ length: 200 }, (_, i) => ({ id: i, value: i * 3, tags: ["a", "b"] })));
console.log(`json-exit ${N} rows total=${total} echoed=${echoed} ms=${Math.round(performance.now() - started)}`);
