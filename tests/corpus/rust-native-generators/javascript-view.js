// @ts-check
// @rust-only
// @no-engine

/** @typedef {{ type: "start", value: number } | { type: "end", value: string }} GenEvent */

/** @returns {Generator<GenEvent, void, unknown>} */
function* events() {
  yield { type: "start", value: 7 };
  yield { type: "end", value: "done" };
}

/** @param {Generator<any, void, unknown>} source */
function consume(source) {
  const values = [];
  for (const event of source) values.push(`${event.type}:${event.value}`);
  return values.join(",");
}

console.log(consume(events()));
