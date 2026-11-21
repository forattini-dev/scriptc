async function run(): Promise<void> {
  const greet = (await import("./4981-dynamic-import-property-lib.ts")).greet;
  console.log(greet("native"));
}

void run();
