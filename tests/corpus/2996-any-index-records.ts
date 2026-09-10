// A record whose index signature is `any`-valued compiles as a checked-dynamic slot in a static build.
type Bag = { [key: string]: any };

const config: Bag = { port: 4000, host: "local", nested: { deep: true } };
console.log(String(config["port"]), String(config["host"]).toUpperCase());
config["extra"] = [1, 2, 3];
console.log(JSON.stringify(config["extra"]), Object.keys(config).sort().join(","));

function describe(bag: Record<string, any>): string {
  const value = bag["kind"];
  return typeof value === "string" ? value : "?";
}
console.log(describe({ kind: "note" }), describe({ kind: 7 }));

type ReadonlyBag = { readonly [x: string]: any };
const mixed: ReadonlyBag = { a: 1, b: "two" };
console.log(String(mixed["a"]), String(mixed["b"]), String(mixed["missing"]));
