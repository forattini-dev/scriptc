async function main(): Promise<void> {
  const option = "--version";
  await Bun.$`rustc ${option}`.quiet().nothrow();
  console.log("done");
}

main();
