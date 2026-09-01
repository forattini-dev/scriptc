async function main(): Promise<void> {
  const specifier = import.meta.url.replace(/\/[^/]+$/, "/computed-target.mjs");
  const namespace = await import(specifier);
  const label: string = namespace.label;
  console.log(label);
}

await main();
