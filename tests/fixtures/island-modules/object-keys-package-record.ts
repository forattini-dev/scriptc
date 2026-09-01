import { parse } from "optionszoo";

const parsed = parse();
for (const name of Object.keys(parsed.options)) {
  console.log(`${name}:${String(parsed.options[name])}`);
}
