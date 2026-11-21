async function run(): Promise<number> {
  let index = 0;
  while (index < 30000) {
    index += 1;
    continue;
  }
  let total = 0;
  while (index < 30002) {
    index += 1;
    let inner = 0;
    while (inner < 2) {
      inner += 1;
      await Promise.resolve(undefined);
      total += 1;
    }
  }
  return index + total;
}
async function main(): Promise<void> {
  const task = run();
  console.log("started");
  const result = await task;
  console.log(result);
}
void main();
