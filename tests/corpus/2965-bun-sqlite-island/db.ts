// The island module (Proxy keeps it there): bun:sqlite over the host's
// SQLite kernel — the drizzle/Effect shapes: prepared statements with
// positional and named bindings, all/get/values/run, transactions that
// roll back, safeIntegers, blobs, constraint errors, serialize.
import { Database, type SQLiteError } from "bun:sqlite";

const guard = new Proxy({ on: true }, {});

export function demo(): string {
  const out: string[] = [];
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, score REAL, data BLOB)");
  const insert = db.prepare("INSERT INTO t (name, score, data) VALUES (?, ?, ?)");
  const r1 = insert.run("ana", 1.5, new Uint8Array([1, 2, 3]));
  const r2 = insert.run("bo", null, null);
  out.push(`run ${r1.changes}/${r1.lastInsertRowid} ${r2.changes}/${r2.lastInsertRowid}`);
  const ana = db.query("SELECT id, name, score, data FROM t WHERE name = $name").get({ $name: "ana" }) as {
    id: number; name: string; score: number; data: Uint8Array;
  };
  out.push(`get ${ana.id} ${ana.name} ${ana.score} [${Array.from(ana.data).join(",")}] ${ana.data.constructor.name}`);
  const rows = db.query("SELECT id, name, score FROM t ORDER BY id").all() as { id: number; name: string; score: number | null }[];
  out.push(`all ${rows.map((r) => `${r.id}:${r.name}:${r.score}`).join(" ")}`);
  const values = db.query("SELECT id, name FROM t ORDER BY id").values();
  out.push(`values ${JSON.stringify(values)}`);
  out.push(`columns ${db.query("SELECT id, name AS label FROM t").columnNames.join(",")}`);
  out.push(`missing ${db.query("SELECT id FROM t WHERE name = ?").get("zed")}`);
  try {
    insert.run("ana", 0, null);
  } catch (e) {
    const err = e as SQLiteError;
    out.push(`error ${err.name} ${err.code} ${err.errno} ${err.message} ${e instanceof Error}`);
  }
  const addAll = db.transaction((names: string[]) => {
    for (const n of names) insert.run(n, 0, null);
    return names.length;
  });
  out.push(`tx ${addAll(["cy", "di"])} ${db.inTransaction}`);
  try {
    addAll(["ed", "ana"]);
  } catch (e) {
    out.push(`rollback ${(e as SQLiteError).code}`);
  }
  const count = db.query("SELECT COUNT(*) AS n FROM t").get() as { n: number };
  out.push(`count ${count.n}`);
  const big = db.query("SELECT 9007199254740993 AS big, 7 AS small").safeIntegers(true).get() as { big: bigint; small: bigint };
  out.push(`safe ${typeof big.big} ${big.big} ${typeof big.small} ${big.small}`);
  const changes = db.run("UPDATE t SET score = 2 WHERE score IS NULL");
  out.push(`update ${changes.changes}`);
  const named = db.query("SELECT name FROM t WHERE score > :min AND id < @max ORDER BY id").all({ ":min": 1, "@max": 4 }) as { name: string }[];
  out.push(`named ${named.map((r) => r.name).join(",")}`);
  const image = db.serialize();
  out.push(`serialize ${image.length > 100} ${image.subarray(0, 15).toString("utf8")}`);
  db.close();
  return out.join("\n") + ((guard as { on: boolean }).on ? "" : "?");
}
