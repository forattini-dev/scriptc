interface Schema {
  readonly type: string;
  readonly items?: Schema;
}

type SchemaOrGetter = Schema | (() => Schema);

function selectParser(kind: string): SchemaOrGetter {
  if (kind === "lazy") {
    return () => {
      console.log("getter called");
      return { type: "array", items: { type: "string" } };
    };
  }
  return { type: kind };
}

function parseDef(kind: string): Schema {
  const schemaOrGetter = selectParser(kind);
  const schema = typeof schemaOrGetter === "function" ? schemaOrGetter() : schemaOrGetter;
  return schema;
}

for (const kind of ["string", "lazy", "number"]) {
  console.log(kind, JSON.stringify(parseDef(kind)));
}

import { parseDefJs } from "./parser.js";
for (const kind of ["string", "lazy", "none"]) {
  console.log("js", kind, JSON.stringify(parseDefJs(kind)));
}
