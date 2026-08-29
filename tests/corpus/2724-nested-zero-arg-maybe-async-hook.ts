interface AgentSupervisorConfig {
  supervisor?: {
    installed?: () => boolean;
    start?: () => Promise<void> | void;
  };
}

async function pause(): Promise<void> {}

async function run(config: AgentSupervisorConfig): Promise<void> {
  console.log(config.supervisor?.installed?.() ?? false);
  if (config.supervisor?.start != null) {
    await config.supervisor.start();
  }
  console.log("started");
}

async function main(): Promise<void> {
  await run({
    supervisor: {
      installed: () => true,
      start: () => console.log("sync start"),
    },
  });
  await run({
    supervisor: {
      start: async () => {
        await pause();
        console.log("async start");
      },
    },
  });
}

main();
