export function parse(args) {
  const result = { options: {} };
  const options = result.options;
  for (const key of args) options[key] = key.length;
  return result;
}
