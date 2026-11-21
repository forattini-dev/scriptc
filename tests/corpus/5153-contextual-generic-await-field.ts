export {};

async function withValue<T>(run: () => Promise<T>): Promise<{ busy: false; value: T }> {
  return { busy: false, value: await run() };
}

async function main(): Promise<void> {
  const result = await withValue(async () => 7);
  console.log(result.busy, result.value);
}

void main();
