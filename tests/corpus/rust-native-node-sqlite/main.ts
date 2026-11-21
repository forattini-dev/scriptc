// @rust-only
// @no-engine
import { DatabaseSync } from "node:sqlite";

const config = { readonly: false, timeout: 250 };
const db = new DatabaseSync(":memory:", {
  readOnly: config.readonly,
  timeout: config.timeout,
  enableForeignKeyConstraints: true,
  open: true,
});
db.exec("CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('native')");
console.log("node sqlite open");
db.close();
