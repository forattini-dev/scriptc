// @rust-only
// A generic function VALUE flowing into a slot that is a union with one family arm — effect's
// `transformRows: (<A extends object>(rows) => …) | undefined` shape. The value joins the arm's closure family and
// wraps at its tag; the absent case keeps the unit arm, and narrowing picks the family back out.
type Rows = <A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>;

function identity<A extends object>(rows: ReadonlyArray<A>): ReadonlyArray<A> {
  return rows;
}

function firstOnly<A extends object>(rows: ReadonlyArray<A>): ReadonlyArray<A> {
  return rows.length === 0 ? rows : [rows[0]!];
}

// The slot as a PARAMETER.
function count(transform: Rows | undefined, rows: ReadonlyArray<{ a: number }>): number {
  return transform ? transform(rows).length : rows.length;
}

const two: ReadonlyArray<{ a: number }> = [{ a: 1 }, { a: 2 }];
console.log(count(identity, two), count(firstOnly, two), count(undefined, two));

// The same family used at a second instantiation: a different row shape demands its own body.
const names: ReadonlyArray<{ name: string }> = [{ name: "ada" }, { name: "grace" }];
console.log(count(identity, two), names.length);
function countNames(transform: Rows | undefined, rows: ReadonlyArray<{ name: string }>): string {
  const kept = transform ? transform(rows) : rows;
  return kept.map((r) => r.name).join(",");
}
console.log(countNames(identity, names), countNames(firstOnly, names), countNames(undefined, names));

// The slot as a RECORD FIELD.
interface Options {
  readonly label: string;
  readonly transform: Rows | undefined;
}

function run(options: Options, rows: ReadonlyArray<{ a: number }>): string {
  const kept = options.transform ? options.transform(rows) : rows;
  return `${options.label}=${kept.length}`;
}

console.log(run({ label: "all", transform: identity }, two));
console.log(run({ label: "one", transform: firstOnly }, two));
console.log(run({ label: "none", transform: undefined }, two));

// The field read twice keeps one value, and the absent arm stays absent.
const opts: Options = { label: "kept", transform: firstOnly };
console.log(run(opts, two), run(opts, two), opts.label);
