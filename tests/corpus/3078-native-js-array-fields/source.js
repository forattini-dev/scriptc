export function parse(args) {
  const result = { errors: [], rest: [], options: {}, nested: [[]] };
  for (const arg of args) {
    if (arg.startsWith("!")) result.errors.push(arg.slice(1));
    else result.rest.push(arg);
  }
  result.options["count"] = args.length;
  result.nested[0].push("inner");
  return result;
}
export function append(result, error) { result.errors.push(error); }
