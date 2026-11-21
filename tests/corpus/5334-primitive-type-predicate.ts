type StringPredicate = (value: unknown) => value is string;

function accepts(test: StringPredicate, value: unknown): boolean {
  return test(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
console.log(accepts(isString, "ok"), accepts(isString, 7));
