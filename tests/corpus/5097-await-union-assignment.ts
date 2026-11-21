async function choose(run: boolean): Promise<(() => string) | undefined> {
  let callback: (() => string) | undefined = undefined;
  if (run) {
    callback = await Promise.resolve(() => "ok");
  }
  return callback;
}

async function main(): Promise<void> {
  const callback = await choose(true);
  console.log(callback!());
}

void main();
