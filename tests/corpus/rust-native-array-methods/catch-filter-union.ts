async function main(): Promise<void> {
  const files = await Promise.resolve(["keep.ts", "skip.js"]).catch(() => []);
  console.log(files.filter((name) => name.endsWith(".ts")).join(","));
}

main();
