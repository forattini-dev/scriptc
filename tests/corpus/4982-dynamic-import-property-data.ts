async function run(): Promise<void> {
  const text = (await import("./4982-dynamic-import-property-data-lib.ts")).nativeText;
  console.log(text);
}

void run();
