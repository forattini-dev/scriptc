export function parse() {
  const result = { rest: [], nested: [[]] };
  result.rest.push("tail");
  result.nested[0].push("inner");
  return result;
}
