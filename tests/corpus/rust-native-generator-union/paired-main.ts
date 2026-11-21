import { decodeFromLines } from "./paired-index.js";

function* lines(): Generator<number, void, unknown> {
  yield 1;
  yield 3;
}

console.log(decodeFromLines(lines()));
