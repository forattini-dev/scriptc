interface Deps {
  declare: (value: string) => void | Promise<void>;
  inspect: (value: string) => Promise<string>;
  optional?: () => Promise<"available" | "absent">;
}

async function defaultDeps(): Promise<Deps> {
  return {
    declare: (value) => { console.log(`declare:${value}`); },
    inspect: async (value) => `inspect:${value}`,
    optional: async () => "available",
  };
}

async function run(injected?: Deps): Promise<void> {
  const deps = injected ?? await defaultDeps();
  await deps.declare("native");
  console.log(await deps.inspect("rust"));
  if (deps.optional) console.log(await deps.optional());
}

void run();
