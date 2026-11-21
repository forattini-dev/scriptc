import * as exports from "./exports.js";

type Factory = (value: string) => string;
const factories = exports as unknown as Record<string, Factory | undefined>;

for (const name of ["alpha", "beta"]) {
  const factory = factories[name];
  if (factory === undefined) throw new Error(`missing ${name}`);
  console.log(name, factory("x"));
}

console.log("missing", factories["missing"] === undefined);
console.log("metadata", Boolean(factories["metadata"]));
