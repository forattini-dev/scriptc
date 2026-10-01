// @rust-only
// @no-engine
// A missing class receiver throws before method arguments are evaluated.
class Row {
  id: number;
  constructor(id: number) { this.id = id; }
  read(offset: number): number { return this.id + offset; }
}
const rows: Row[] = [new Row(4)];
let effects = "";
function receiver(): Row[] { effects += "receiver;"; return rows; }
function index(value: number): number { effects += "index;"; return value; }
function argument(): number { effects += "argument;"; return 3; }
console.log("present", receiver()[index(0)].read(argument()), effects);
effects = "";
try {
  console.log("missing", receiver()[index(1)].read(argument()));
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log("effects", effects);
rows.length = 2;
for (const row of rows) {
  try { console.log("iteration", row.read(2)); }
  catch (error) { console.log(error instanceof TypeError, (error as Error).message); }
}
