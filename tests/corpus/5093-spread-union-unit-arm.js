// @ts-nocheck
function value(kind) {
  if (kind === "array") return ["x", "y"];
  if (kind === "bool") return true;
  if (kind === "number") return 1;
  if (kind === "string") return "ab";
  return null;
}

function append(kind) {
  const output = [];
  output.push(...value(kind));
  return output.join(",");
}

console.log(append("array"));
console.log(append("string"));
try {
  append("null");
} catch (error) {
  console.log(error instanceof TypeError);
}
