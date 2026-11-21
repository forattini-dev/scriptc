type Environment = Record<string, string | undefined>;

function inspect(options: { env?: Environment }): void {
  const env = options.env!;
  console.log("values", env["DEBIAN_FRONTEND"], env["NODE_ENV"] ?? "missing");
  env["EXTRA"] = "shared";
}

const optional = process.env["SCRIPTC_OPTIONAL_VIEW_TEST"];
const env = {
  DEBIAN_FRONTEND: "noninteractive",
  NODE_ENV: optional,
};
inspect({ env });
console.log("extra", (env as Environment)["EXTRA"]);
