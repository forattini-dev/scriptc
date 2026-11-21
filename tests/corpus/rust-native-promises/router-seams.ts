interface RouterSeams {
  run?: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number | null; out?: string }>;
  home?: string;
  env?: { [key: string]: string | undefined; NODE_ENV?: string; TZ?: string };
  routerBinary?: string | null;
  miseBinary?: string | null;
  answering?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  startHidden?: (runner: string, wrapper: string) => void;
  hiddenRunner?: () => Promise<string | null>;
}
function describe(seams: RouterSeams = {}): string {
  return seams.home ?? "default";
}
console.log(describe());
console.log(describe({ home: "native" }));
function environment(seams: RouterSeams): string {
  return seams.env?.NODE_ENV ?? "missing";
}
const env = { NODE_ENV: "before", EXTRA: "x" };
const options: RouterSeams = { env };
console.log(environment(options));
console.log((options.env?.["EXTRA"] ?? "missing") as string);
env.NODE_ENV = "after";
env.EXTRA = "changed";
console.log(environment(options));
console.log((options.env?.["EXTRA"] ?? "missing") as string);
console.log(environment({}));
function start(seams: RouterSeams): void {
  if (seams.startHidden) seams.startHidden("runner", "wrapper");
}
start({ startHidden: (runner, wrapper) => { console.log(runner); console.log(wrapper); } });
