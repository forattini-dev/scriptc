async function work(): Promise<number> {
  return 7;
}

async function main(): Promise<void> {
  let stopping: Promise<void> | undefined;
  const source: Promise<any> = work();
  stopping = source;
  await stopping;
  console.log("stopped");
}

void main();
