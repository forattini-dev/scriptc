interface CsvParseOptions { delimiter?: string; headers?: boolean }

export function parseCsv(csv: string, options: CsvParseOptions & { headers?: true }): Record<string, string>[];
export function parseCsv(csv: string, options: CsvParseOptions & { headers: false }): string[][];
export function parseCsv(csv: string, options?: CsvParseOptions): Record<string, string>[] | string[][];
export function parseCsv(csv: string, options: CsvParseOptions = {}): Record<string, string>[] | string[][] {
  const delimiter = options.delimiter ?? ",";
  const rows = csv.trim().split("\n").map((line) => line.split(delimiter));
  if (options.headers === false) {
    return rows;
  }
  const [header, ...body] = rows;
  return body.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? "";
    });
    return record;
  });
}

function describe(value: number): string;
function describe(value: string): string;
function describe(value: number | string): string {
  return typeof value === "number" ? `#${value.toFixed(1)}` : `"${value}"`;
}

const text = "name,role\nada,admin\nlin,dev";
const records = parseCsv(text, { headers: true });
console.log(records.length, records[1].name, records[0].role);
const grid = parseCsv(text, { headers: false });
console.log(grid.length, grid[2].join("/"));
const semi = parseCsv("a;b\n1;2", { delimiter: ";" });
console.log(JSON.stringify(semi));
console.log(describe(3), describe("x"));
