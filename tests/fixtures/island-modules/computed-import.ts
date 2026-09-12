async function main(): Promise<void> {
  // Native callers can locate runtime assets beside the executable explicitly.
  const base = process.argv[2] ?? import.meta.url;
  const specifier = base.replace(/\/[^/]+$/, "/computed-target.mjs");
  const namespace = await import(specifier);
  const label: string = namespace.label;
  console.log(label);
}

await main();
