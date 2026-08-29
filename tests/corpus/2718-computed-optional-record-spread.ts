interface ClientOptions {
  label?: string;
  retries?: number;
}

interface RequestOptions extends ClientOptions {
  sessionProject?: string;
}

let sourceCalls = 0;

function clientOptions(present: boolean): ClientOptions | undefined {
  sourceCalls++;
  return present ? { label: "agent", retries: 3 } : undefined;
}

function buildOptions(present: boolean, project: string | undefined): RequestOptions {
  return {
    ...(clientOptions(present) ?? {}),
    ...(project == null ? {} : { sessionProject: project }),
  };
}

function printOptions(present: boolean, project: string | undefined): void {
  const options = buildOptions(present, project);
  console.log(
    options.label ?? "none",
    options.retries ?? -1,
    options.sessionProject ?? "none",
    sourceCalls,
  );
}

printOptions(true, "scriptc");
printOptions(false, undefined);
