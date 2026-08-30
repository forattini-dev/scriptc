interface CensusRow {
  pid: number;
  unit: string;
}

interface ReaperOptions {
  census?: () => readonly CensusRow[] | Promise<readonly CensusRow[]>;
}

function defaultCensus(): readonly CensusRow[] {
  return [{ pid: 1, unit: "default" }];
}

async function pause(): Promise<void> {}

async function scan(options: ReaperOptions): Promise<void> {
  const census = options.census ?? defaultCensus;
  const rows = await census();
  for (const row of rows) console.log(`${row.pid}:${row.unit}`);
}

async function main(): Promise<void> {
  await scan({ census: () => [{ pid: 7, unit: "sync" }] });
  await scan({
    census: async () => {
      await pause();
      return [{ pid: 9, unit: "async" }];
    },
  });
  await scan({});
}

main();
