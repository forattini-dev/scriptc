// @no-engine
// A shared catch must see current cells, cross awaits, and retain loop frames.
function settle(mode: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (mode === 0) reject(new Error("await"));
    else resolve(1);
  });
}

async function probe(mode: number): Promise<number> {
  let value = mode;
  try {
    value += 10;
    await settle(mode);
    value += 100;
    if (mode === 1) throw new Error("segment");
    return value;
  } catch (error) {
    console.log("caught", mode, value, error instanceof Error ? error.message : "unknown");
    await Promise.resolve();
    value += 1000;
    if (mode === 0) throw new Error("catch");
    return value;
  } finally {
    console.log("finally", mode, value);
    await Promise.resolve();
    console.log("cleanup", mode);
  }
}

async function main(): Promise<void> {
  for (const mode of [0, 1, 2]) {
    try {
      console.log("result", await probe(mode!));
    } catch (error) {
      console.log("outer", error instanceof Error ? error.message : "unknown");
      await Promise.resolve();
    }
    console.log("next", mode);
  }
}

main();
