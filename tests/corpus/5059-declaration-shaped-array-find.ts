interface ParseResult {
  errors: string[];
}

function firstMissing(parsed: ParseResult): string | undefined {
  return parsed.errors.find((error) => /^Option --?\S+ requires a value$/.test(error));
}

console.log(firstMissing({ errors: ["other", "Option --name requires a value"] }));
console.log(firstMissing({ errors: [] }) === undefined);
