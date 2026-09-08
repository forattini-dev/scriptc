// @no-engine
// @rust-only
// Native module namespace reads preserve live bindings and object identity.
// Node 24 places numeric index exports first, then sorts names by UTF-16.
async function main(): Promise<void> {
  const pending = import("./module.ts");
  const promiseAlias = pending;
  const namespace = await promiseAlias;
  let alias = namespace;
  var hoisted = alias;
  console.log("keys", Object.keys(namespace).join(","));
  console.log("before", JSON.stringify(namespace));
  console.log("bump", hoisted.bump());
  console.log("live", namespace.counter, alias.live, namespace.default);
  const data = await import("./data.ts");
  console.log("values", JSON.stringify(Object.values(data)));
  console.log("entries", JSON.stringify(Object.entries(data)));
  console.log("inspect", data);
  try { structuredClone(data); }
  catch (error) { console.log((error as Error).name, (error as Error).message); }
  console.log("after", JSON.stringify(namespace));
  const again = await import("./module.ts");
  console.log("identity", namespace === again, namespace.bump === again.bump);
  const fn: any = namespace.bump;
  fn.label = "kept";
  const repeated: any = namespace.bump;
  console.log("function alias", namespace.bump === namespace.aliasBump, repeated.label);
  const writable: any = alias;
  try { writable.counter = 99; }
  catch (error) { console.log((error as Error).message); }
  try { writable.extra = 99; }
  catch (error) { console.log((error as Error).message); }
  console.log("unchanged", namespace.counter);
  let rebound: any = namespace;
  rebound = "plain";
  console.log("reassigned", rebound);
  await import("./module.ts").then(value => {
    const callbackAlias = value;
    console.log("then", callbackAlias === namespace, callbackAlias.live);
  });
}
main();
export {};
