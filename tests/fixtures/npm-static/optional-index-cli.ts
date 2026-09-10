import { looksLikeValue } from "optional-index";
function parse(argv: string[], index: number): string {
  if (!looksLikeValue(argv[index])) throw new Error("requires a value");
  return argv[index];
}
let order = "";
function source(): string[] { order += "source;"; return ["value", "-flag", ""]; }
function index(value: number): number { order += "index;"; return value; }
for (const i of [0, 1, 2, 3, -1, 0.5]) {
  try { console.log(parse(source(), index(i))); }
  catch (error) { console.log(String(error)); }
}
console.log(order);
