// Start promises gate pulls; async pulls serialize and honor backpressure.
async function main(): Promise<void> {
  let next = 0;
  let active = 0;
  const stream = new ReadableStream<number>({
    async start() {
      console.log("start");
      await Promise.resolve();
      console.log("started");
    },
    async pull(controller) {
      active++;
      console.log("pull", next, active);
      await Promise.resolve();
      controller.enqueue(next++);
      active--;
      if (next === 3) controller.close();
    },
  });
  console.log("constructed");
  const reader = stream.getReader();
  const values: number[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    values.push(result.value);
  }
  console.log(values.join(","), active);
  reader.releaseLock();
}
void main();
