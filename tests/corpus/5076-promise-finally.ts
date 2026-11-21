async function main(): Promise<void> {
  const value = await Promise.resolve(2).finally(() => {
    console.log("cleanup");
  });
  console.log(value);
}

main();
console.log("entry");
