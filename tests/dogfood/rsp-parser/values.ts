import { looksLikeValue, type Token, type OptionDefinition } from "cli-args-parser";

for (const value of ["", "word", "--help", "-1", "-1.5", "-", "https://example.test", "--"]) {
  console.log(JSON.stringify(value), looksLikeValue(value));
}
