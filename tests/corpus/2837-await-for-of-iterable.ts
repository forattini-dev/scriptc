// Real-project shape from red-dev: await an array-producing operation directly
// in the iterable position, then consume the resolved array with for-of.
async function rows(prefix: string): Promise<string[]> {
  await Promise.resolve();
  return [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
}

async function main(): Promise<void> {
  for (const row of await rows("item")) {
    console.log(row);
    await Promise.resolve();
  }
  try {
    for (const row of await rows("guarded")) {
      console.log(row);
      await Promise.resolve();
    }
  } catch {
    console.log("unexpected");
  }
  console.log("done");
}

main();
