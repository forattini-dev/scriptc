type Row = Record<string, string | number | null>;

function firstId(rows: Row[]): number {
  return rows[0].id as number;
}

console.log(firstId([{ id: 1 }]));

let evaluations = 0;
function makeRows(): Row[] {
  evaluations++;
  return [{ id: evaluations }];
}
console.log(makeRows()[0].id, evaluations);

try {
  firstId([]);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
