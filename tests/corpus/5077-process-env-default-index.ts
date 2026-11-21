const defaultEnv: Readonly<Record<string, string | undefined>> = {};

function readEnv(
  env: Readonly<Record<string, string | undefined>> = defaultEnv,
): string {
  return env["SCRIPTC_MISSING_ENV"] ?? "missing";
}

console.log(readEnv({ SCRIPTC_MISSING_ENV: "present" }));
console.log(readEnv({}));
