type Parsed = {
  positional: string[] | { scope: string } | { count: number } | undefined;
  options: string[] | { repair: string } | { apply: boolean } | undefined;
};

function readScope(parsed: Parsed): string {
  const options = parsed.options as Record<string, unknown>;
  const positional = parsed.positional as Record<string, unknown>;
  const rawScope = positional["scope"];
  const repair = options["repair"];
  return `${typeof rawScope === "string" ? rawScope : "missing"}:${typeof repair === "string" ? repair : "missing"}`;
}

console.log(readScope({ positional: { scope: "native" }, options: { repair: "rust" } }));
console.log(readScope({ positional: ["other"], options: ["other"] }));
