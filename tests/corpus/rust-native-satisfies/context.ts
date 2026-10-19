// @rust-only
// @no-engine
const environment = { CI: "1", NONINTERACTIVE: "1", MODE: "native" } as const satisfies Readonly<Record<string, string>>;
console.log("env", environment.CI, environment.NONINTERACTIVE, environment.MODE, Object.keys(environment).join("|"));
function consume(value: { path?: string }): string {
  if (value.path === undefined) { return "missing"; }
  return value.path;
}
console.log("literal context", consume(({ path: "native" } satisfies { path: string })));
const handlers = { value: (value: number): number => value + 1 } satisfies { value: (value: number) => number };
console.log("callback context", handlers.value(3));
function factory(value: boolean): { name: string } | null { return value ? { name: "native" } : null; }
const optional = factory(true) satisfies { name: string } | null;
if (optional !== null) { console.log("union", optional.name); }
