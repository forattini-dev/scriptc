interface StarttimeOptions {
  readStarttime?: (pid: number) => string | null | Promise<string | null>;
}

function defaultReadStarttime(): string | null {
  return null;
}

async function pause(): Promise<void> {}

async function check(pid: number, options: StarttimeOptions): Promise<void> {
  const readStarttime = options.readStarttime ?? defaultReadStarttime;
  const starttime = await readStarttime(pid);
  console.log(starttime ?? "missing");
}

async function main(): Promise<void> {
  await check(7, { readStarttime: (pid) => `sync-${pid}` });
  await check(8, { readStarttime: () => null });
  await check(9, {
    readStarttime: async (pid) => {
      await pause();
      return `async-${pid}`;
    },
  });
  await check(10, {
    readStarttime: async () => {
      await pause();
      return null;
    },
  });
  await check(11, {});
}

main();
