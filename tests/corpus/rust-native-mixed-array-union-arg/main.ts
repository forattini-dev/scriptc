function serializeCsv(data: Record<string, any>[] | any[][], delimiter = ","): string {
  if (data.length === 0) return "";
  if (Array.isArray(data[0])) {
    return (data as any[][]).map((row) => row.join(delimiter)).join("\n");
  }
  const rows = data as Record<string, any>[];
  const columns = Object.keys(rows[0]);
  return [columns.join(delimiter), ...rows.map((row) => columns.map((name) => String(row[name])).join(delimiter))].join("\n");
}

function handler(args: Record<string, unknown>): string {
  const data = args.data as Array<Record<string, unknown> | unknown[]>;
  const delimiter = (args.delimiter as string) || ",";
  return serializeCsv(data, delimiter);
}

console.log(handler({ data: [{ name: "ada", role: "admin" }, { name: "lin", role: "dev" }] }));
console.log(handler({ data: [["a", 1], ["b", 2]], delimiter: ";" }));
console.log(JSON.stringify(handler({ data: [] })));
