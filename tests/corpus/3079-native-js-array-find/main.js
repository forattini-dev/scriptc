// @no-engine
// @rust-only
function parse() {
  const result = { errors: [], rest: [] };
  result.errors.push("bad");
  result.errors.push("other");
  result.errors.push("bad-last");
  result.rest.push("tail");
  return result;
}
const parsed = parse();
const found = parsed.errors.find(error => /^bad/.test(error));
if (found !== undefined) console.log("first", found.replace(/^b/, "B"));
const last = parsed.errors.findLast(error => error.startsWith("bad"));
if (last !== undefined) console.log("last", last.toUpperCase());
const missing = parsed.errors.find(error => error === "missing");
console.log("missing", missing === undefined);
console.log("map", parsed.errors.map(error => error.toUpperCase()).join(","));
console.log("some", parsed.errors.some(error => error === "other"));
console.log("every", parsed.errors.every(error => error.length > 0));
const at = parsed.errors.at(0);
if (at !== undefined) console.log("at", at.toUpperCase());
const popped = parsed.errors.pop();
if (popped !== undefined) console.log("pop", popped.toUpperCase());
const shifted = parsed.errors.shift();
if (shifted !== undefined) console.log("shift", shifted.toUpperCase());

function localSearch() {
  const result = parse();
  const found = result.errors.find(error => error.startsWith("bad"));
  if (found !== undefined) console.log("local", found.toUpperCase());
  const row = { label: "row" };
  const mixed = { items: [] };
  mixed.items.push("text", 7, row);
  const selected = mixed.items.find(item => item === row);
  console.log("reference", selected === row);
  const number = mixed.items.find(item => typeof item === "number");
  console.log("number", number);
  let visited = 0;
  try {
    result.errors.find(error => { visited++; throw new Error(error); });
  } catch (error) { console.log("throw", error.message, visited); }
}
localSearch();
