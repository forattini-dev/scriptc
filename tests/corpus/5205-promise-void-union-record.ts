type Stage = "system" | "other";

async function systemUpdate(): Promise<void> {
  console.log("system");
}

const stages: Record<Stage, () => Promise<number | void>> = {
  system: () => systemUpdate(),
  other: async () => 7,
};

async function main(): Promise<void> {
  await stages.system();
  await stages.other();
  console.log("other");
}

void main();
