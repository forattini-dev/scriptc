// @rust-only
// @no-engine
// Missing iteration values survive await and protected continuations.
const keys: string[] = ["a"];
keys.length = 2;
let evaluations = 0;
async function source(): Promise<string[]> {
  evaluations++;
  await Promise.resolve();
  return keys;
}
async function main(): Promise<void> {
  const seen: string[] = [];
  try {
    for (const key of await source()) {
      seen.push(`${typeof key}:${String(key)}`);
      await Promise.resolve();
      if (seen.length === 1) keys.push("b");
      if (seen.length === 3) throw new Error("after resume");
    }
  } catch (error) {
    console.log("catch", (error as Error).message);
  } finally {
    console.log("finally", seen.join(","), evaluations);
  }
  try {
    for (const key of keys) {
      console.log("before", typeof key);
      await Promise.reject(new Error("dependency"));
    }
  } catch (error) {
    console.log("reject", (error as Error).message);
  } finally {
    console.log("done");
  }
}
main();
