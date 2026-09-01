interface Core {
  main(value: number): Promise<number>;
}

async function main(value: number): Promise<number> {
  return await Promise.resolve(value + 1);
}

async function loadCore(): Promise<Core> {
  await Promise.resolve();
  return { main };
}

async function run(): Promise<number> {
  return await (await loadCore()).main(41);
}

run().then((value) => console.log(value));
