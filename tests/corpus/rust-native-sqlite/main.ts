// @rust-only
// @no-engine
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
console.log(db.serialize().length > 0);
db.close();
