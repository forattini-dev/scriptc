// @no-engine
const first: ProjectRow = { name: "first", value: 21 };
const rows: ProjectRow[] = [first, { name: "second", value: 2 }];
console.log(rows[0].name, rows[0].value * rows[1].value);

try { console.log(missingRow.name); } catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
