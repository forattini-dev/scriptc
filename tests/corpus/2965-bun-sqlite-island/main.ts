// @dynamic
// @target bun
// @island-module: ./db.ts
// bun:sqlite inside the island: the host's SQLite kernel answers the
// Database/Statement surface drizzle and Effect's SqlClient drive.
import { demo } from "./db.ts";

console.log(demo());
