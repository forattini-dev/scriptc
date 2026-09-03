// `await import("./data.json", { with: { type: "json" } })` — the JSON
// module read a zero-dependency CLI uses to find its own version
// (tuiuiu.js's getVersion is exactly this, inside a try/catch). The
// document is data known at build time, so the call bakes into an
// already-resolved promise over the namespace record and the program
// stays FULLY STATIC: no dynamic engine, no import() fence. Node runs the
// same import natively, so every field read below is differential.
//
// Node's JSON module exposes ONE binding, `default` — the two spellings
// below (the `.default` read and the `as`-cast every CLI writes) are the
// whole readable surface. Binding the namespace ITSELF to a variable
// keeps its fence: tsgo types that namespace with the document's fields
// beside `default`, a shape Node does not actually hand out.
async function main(): Promise<void> {
  const pkg = (await import("./data.json", { with: { type: "json" } })).default;
  console.log(pkg.name, pkg.version);
  console.log(pkg.count + 1, pkg.enabled);
  console.log(pkg.keywords.length, pkg.keywords[0], pkg.keywords[2]);
  console.log(pkg.config.retries * 2, pkg.config.mode);
  console.log(pkg.config.flags[0], pkg.config.flags[1]);

  // The try/catch a version reader wraps it in. The catch arm is
  // unreachable in a compiled binary (the document is baked, so the read
  // cannot fail) — a divergence inherited from the static JSON binding,
  // and the loud one: a missing or malformed document is a BUILD error.
  let version = "0.0.0-dev";
  try {
    const again = await import("./data.json", { with: { type: "json" } }) as {
      default: { version: string };
    };
    version = again.default.version;
  } catch {
    version = "0.0.0-dev";
  }
  console.log(`v${version}`);

  // Two imports of one document read the same values.
  const twice = (await import("./data.json", { with: { type: "json" } })).default;
  console.log(twice.name === pkg.name, twice.config.mode === pkg.config.mode);
}

main();
