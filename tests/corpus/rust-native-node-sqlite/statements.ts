// @rust-only
// @no-engine
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item (name) VALUES ('a'), ('b')");

const select = db.prepare("SELECT id, name FROM item ORDER BY id");
select.setReadBigInts(false);
console.log(JSON.stringify(select.all()));
console.log(JSON.stringify(select.get()));
select.setReturnArrays(true);
console.log(JSON.stringify(Array.from(select.iterate())));

const insert = db.prepare("INSERT INTO item (name) VALUES (?)");
const result = insert.run("c");
console.log(result.changes, result.lastInsertRowid);

const named = db.prepare("SELECT name FROM item WHERE id = $id");
console.log(JSON.stringify(named.get({ id: 3 })));
db.close();
