// Engine-free literal import(): compiled ESM and Node builtin namespaces
// resolve on the native microtask queue, preserve one namespace identity,
// and keep exported mutable bindings live across repeated imports.
console.log("start");

const firstPromise = import("./mod.ts");
const secondPromise = import("./mod.ts");
console.log("sync tail");

async function main(): Promise<void> {
  const first = await firstPromise;
  const second = await secondPromise;
  console.log("identity", first === second);
  console.log("initial", first.count, second.count);
  first.bump();
  console.log("live", first.count, second.count);
  console.log("class", new first.Box(7).value());
  console.log("default", first.default);
  console.log("keys", Object.keys(first).join(","));

  const viaThen = await import("./mod.ts").then((ns) => ns.label());
  console.log("then", viaThen);

  const path = await import("node:path");
  const pathAgain = await import("node:path");
  console.log("builtin identity", path === pathAgain);
  console.log("builtin", path.join("a", "b"), path.sep.length > 0, typeof path);
  console.log("builtin then", await import("node:path").then((ns) => ns.basename("a/b.txt")));
}

main();
