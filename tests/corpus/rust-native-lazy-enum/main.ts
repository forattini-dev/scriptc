async function main(): Promise<void> {
  const loaded = await import("./node-type.ts");
  console.log(loaded.default.TEXT_NODE, loaded.default[3]);
}

void main();
