interface ReclaimOptions {
  isPidAlive?: (pid: number) => boolean | Promise<boolean>;
}

function defaultIsPidAlive(pid: number): boolean {
  return pid === 1;
}

async function pause(): Promise<void> {}

async function judge(pid: number, options: ReclaimOptions): Promise<void> {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  console.log(await isPidAlive(pid));
}

async function main(): Promise<void> {
  await judge(7, { isPidAlive: (pid) => pid === 7 });
  await judge(9, {
    isPidAlive: async (pid) => {
      await pause();
      return pid === 9;
    },
  });
  await judge(2, {});
}

main();
