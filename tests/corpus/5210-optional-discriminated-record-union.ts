type Row =
  | { kind: "tool"; name: string }
  | { kind: "web"; url: string };

const rows = new Map<string, { row: Row }>();
rows.set("native", { row: { kind: "tool", name: "rust" } });

const present = rows.get("native")?.row;
const absent = rows.get("missing")?.row;

console.log(`${present?.kind ?? "missing"}`);
console.log(`${absent?.kind ?? "missing"}`);
