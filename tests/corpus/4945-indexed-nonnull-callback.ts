// @rust-only
// @no-engine
type Row = Record<string, unknown>;
type Projection = (row: Row) => unknown;

const projections: Readonly<Record<string, Projection>> = {
  name: (row) => row.name,
  size: (row) => String(row.name).length,
};

function project(fields: readonly string[], row: Row): Row {
  const out: Row = {};
  for (const field of fields) out[field] = projections[field]!(row);
  return out;
}

const result = project(["name", "size"], { name: "scriptc" });
console.log(String(result.name));
console.log(Number(result.size));
