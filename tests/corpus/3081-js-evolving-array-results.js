// @no-engine
const values = [];
values.push("first", "last");
const alias = values;
const found = alias.find(value => value === "first");
if (found !== undefined) console.log("find", found.toUpperCase());
const last = values.findLast(value => value.length > 0);
if (last !== undefined) console.log("last", last.toUpperCase());
const missing = values.find(value => value === "absent");
console.log("missing", missing === undefined);
const at = values.at(0);
if (at !== undefined) console.log("at", at.toUpperCase());
const shifted = values.shift();
if (shifted !== undefined) console.log("shift", shifted.toUpperCase());
const popped = values.pop();
if (popped !== undefined) console.log("pop", popped.toUpperCase());
console.log("empty", values.pop() === undefined, alias.length);

function local() {
  const entries = [];
  entries.push("local");
  const selected = entries.find(entry => /^loc/.test(entry));
  if (selected !== undefined) console.log("local", selected.replace(/^l/, "L"));
}
local();
