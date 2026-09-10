import { splitLines, measure } from "inferred-lines";
for (const text of ["", "one", "one\n", "one\ntwo", "one\r\ntwo\r\n", "\n\n"]) {
  const lines = splitLines(text);
  console.log(JSON.stringify(lines), lines.length);
}
console.log(JSON.stringify(measure("one\n  two\n    three\n")));
