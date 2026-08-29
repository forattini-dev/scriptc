interface BedrockOptions {
  cwd?: string;
  version?: string;
}

let bedrockCalls = 0;

function bedrockOptions(present: boolean): BedrockOptions | undefined {
  bedrockCalls++;
  return present ? { cwd: "bedrock", version: "2" } : undefined;
}

function buildOptions(cwd: string | undefined, present: boolean): BedrockOptions {
  return {
    ...(cwd == null ? {} : { cwd }),
    ...(bedrockOptions(present) ?? {}),
  };
}

function printOptions(cwd: string | undefined, present: boolean): void {
  const options = buildOptions(cwd, present);
  console.log(
    options.cwd ?? "none",
    options.version ?? "none",
    bedrockCalls,
  );
}

printOptions("local", true);
printOptions("local", false);
printOptions(undefined, true);
printOptions(undefined, false);
