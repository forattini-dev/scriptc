type ParsedValue = string[] | { message: string } | { code: number };

function parseDynamic(): any {
  return { errors: ["first", "second"] };
}

const parsed: { errors?: ParsedValue } = parseDynamic();
const errors = parsed.errors;
if (Array.isArray(errors)) {
  console.log(errors.join("|"));
}
