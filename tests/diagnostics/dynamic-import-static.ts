// Static import() embeds a fixed graph, so a runtime-computed specifier
// remains an explicit refusal even though literal program/builtin modules
// now compile without the dynamic engine.
async function run(specifier: string): Promise<void> {
  const module = await import(specifier);
  console.log(module);
}
run("node:path");
