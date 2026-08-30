const tails = new Map<string, Promise<void | undefined>>();

async function pause(): Promise<void> {}

async function enqueue(key: string, shouldFail: boolean): Promise<void> {
  const previous = tails.get(key) ?? Promise.resolve();
  const tail = previous
    .then(async () => {
      await pause();
      console.log(`run-${key}`);
      if (shouldFail) throw new Error(`failed-${key}`);
    })
    .catch(() => undefined);
  tails.set(key, tail);
  await tail;
  console.log(`done-${key}`);
}

async function main(): Promise<void> {
  await enqueue("a", false);
  await enqueue("a", true);
  await enqueue("b", false);
}

main();
