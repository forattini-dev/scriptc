import { parse } from "optionszoo";

const parsed = parse();
for (const name of ["missing", "alpha", "beta"]) {
  const raw = parsed.options[name];
  if (raw === undefined) continue;
  console.log(`${name}:${raw}`);
}
