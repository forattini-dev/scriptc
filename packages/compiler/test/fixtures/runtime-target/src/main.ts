import { driver } from "#db";

// The package.json "imports" map branches on the runtime condition: the
// --target profile decides which arm the compiled graph embeds (bun →
// "bun", node24/node26 → "node"; a resolver with neither condition
// falls to "default").
console.log(driver);
