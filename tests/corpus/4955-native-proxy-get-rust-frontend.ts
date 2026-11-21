// @rust-only
// @no-engine

const palette: Record<string, string> = { blue: "ready" };
const proxy = new Proxy(
  {},
  {
    get(_target: object, key: string | symbol): string {
      return typeof key === "string" ? (palette[key] ?? "missing") : "symbol";
    },
  },
);
const dynamic: any = proxy;
console.log(`${dynamic.blue}|${dynamic.red}`);
