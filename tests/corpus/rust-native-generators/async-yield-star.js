// @ts-check
// @rust-only
// @no-engine

export {};

/** @param {string} source @returns {string[]} */
function splitLines(source) {
  return source.split("\n");
}

/** @param {string} source */
async function* toLines(source) {
  yield* splitLines(source);
  yield "tail";
}

async function main() {
  /** @type {string[]} */
  const values = [];
  for await (const line of toLines("a\nb")) values.push(line);
  console.log(values.join(","));
  return 0;
}

main();
