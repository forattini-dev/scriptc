// @dynamic
// `await import(spec)` of an embedded package: the realm's module system
// answers a promise of the whole NAMESPACE, bridged to the static
// Promise the await parks on.
async function main(): Promise<void> {
  const zoo = await import("classzoo");
  console.log(`${zoo.armed.label}:${zoo.idle.label}`);
}

await main();
