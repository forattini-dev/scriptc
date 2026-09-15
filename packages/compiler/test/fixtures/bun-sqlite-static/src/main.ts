/// <reference path="./bun-sqlite.d.ts" />
// Static bun:sqlite under --target bun: the shapes Redcode's database layer uses.
import { Database } from "bun:sqlite";

const db = new Database(":memory:", { readwrite: true, create: true });
const created = db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n REAL)");
console.log(created.changes, created.lastInsertRowid);

const first = db.run("INSERT INTO t (name, n) VALUES (?, ?)", ["a", 1.5]);
console.log(first.changes, first.lastInsertRowid);
const insert = db.query("INSERT INTO t (name, n) VALUES (?, ?)");
const second = insert.run("b", 2);
console.log(second.changes, second.lastInsertRowid);

const rows: unknown[] = db.query("SELECT id, name, n FROM t ORDER BY id").all();
console.log(JSON.stringify(rows));
console.log(JSON.stringify(db.query("SELECT id, name FROM t ORDER BY id").values() as unknown[][]));
console.log(JSON.stringify(db.query("SELECT name FROM t WHERE id = ?").get(2)));
console.log(db.query("SELECT name FROM t WHERE id = ?").get(99) === null);
console.log(JSON.stringify(db.prepare("SELECT name FROM t WHERE id = $id").get({ $id: 1 })));

const params: unknown[] = ["b"];
console.log(JSON.stringify(db.query("SELECT id FROM t WHERE name = ?").all(...(params as any))));

const statement = db.query("SELECT id FROM t WHERE name = ?");
// @ts-ignore bun-types is missing safeIntegers
statement.safeIntegers(true);
const safe = statement.get("a") as { id: unknown };
console.log(typeof safe.id);
// @ts-ignore bun-types is missing safeIntegers
statement.safeIntegers(false);
const plain = statement.get("a") as { id: unknown };
console.log(typeof plain.id);

console.log(db.serialize().length > 0);
try {
  db.run("INSERT INTO t (id, name) VALUES (1, 'dup')");
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
db.close();
db.close();
console.log("closed");
