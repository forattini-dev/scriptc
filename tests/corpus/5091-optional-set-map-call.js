/** @param {{ seen?: Set<string>, labels?: Map<string, number> }} state */
function inspect(state) {
  const known = state.seen?.has("x");
  const label = state.labels?.get("x");
  return `${known}:${label}`;
}

console.log(inspect({ seen: new Set(["x"]), labels: new Map([["x", 2]]) }));
console.log(inspect({}));
