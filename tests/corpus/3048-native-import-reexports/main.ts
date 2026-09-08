// @rust-only
// @no-engine
// Star diamonds preserve binding identity, explicit exports and live aliases.
async function main(): Promise<void> {
  const namespace = await import("./barrel.ts");
  console.log("keys", Object.keys(namespace).join(","));
  console.log("before", namespace.counter, namespace.snapshot, namespace.liveDefault);
  console.log("special", namespace["2"], namespace["10"], namespace.__value);
  console.log("override", namespace.label, namespace.left, namespace.right);
  const base = await import("./base.ts");
  console.log("function identity", namespace.bump === base.bump, namespace.bump === namespace.aliasBump);
  console.log("bump", namespace.aliasBump());
  console.log("after", namespace.counter, namespace.aliasCounter, namespace.live, namespace.liveDefault);
  console.log("snapshot", namespace.snapshot, namespace.renamedSnapshot, base.default);
  const again = await import("./barrel.ts");
  console.log("namespace identity", namespace === again);
}
main();
console.log("entry");
export {};
