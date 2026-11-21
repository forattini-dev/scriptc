import { parseDef } from "./schema.js";

const seen = new Map<string, string>([["user", "user"], ["team", "team"]]);
for (const kind of ["user", "team", "other"]) {
  const schema = parseDef(kind, seen);
  console.log(kind, JSON.stringify(schema), schema !== undefined && "$ref" in schema);
}
