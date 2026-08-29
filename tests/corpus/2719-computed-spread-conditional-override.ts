interface AgentClientOptions {
  label?: string;
  sessionProject?: string;
}

let sourceCalls = 0;

function baseOptions(present: boolean): AgentClientOptions | undefined {
  sourceCalls++;
  return present ? { label: "agent", sessionProject: "old" } : undefined;
}

function buildOptions(present: boolean, project: string | undefined): AgentClientOptions {
  return {
    ...(baseOptions(present) ?? {}),
    ...(project == null ? {} : { sessionProject: project }),
  };
}

function printOptions(present: boolean, project: string | undefined): void {
  const options = buildOptions(present, project);
  console.log(
    options.label ?? "none",
    options.sessionProject ?? "none",
    sourceCalls,
  );
}

printOptions(true, undefined);
printOptions(true, "new");
printOptions(false, undefined);
printOptions(false, "newer");
