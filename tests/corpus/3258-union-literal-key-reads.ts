// @rust-only
// Keyed reads over record | class unions whose key is a pure expression
// typed as ONE literal: the generic `latest(items, key)` pattern, where each
// instantiation's `key` reads a declared field of every arm, optional chains
// included. Absent optional fields, explicit undefined, and class identity.
class Options {
  maxTokens: number | undefined;
  label: string | undefined;
  constructor(maxTokens: number | undefined, label: string | undefined) {
    this.maxTokens = maxTokens;
    this.label = label;
  }
}

type Fields = { readonly maxTokens?: number; readonly label?: string };
type Input = Options | Fields;

const latest = <Key extends keyof Fields>(items: ReadonlyArray<Input | undefined>, key: Key) =>
  items.findLast((item) => item?.[key] !== undefined)?.[key];

const shared = new Options(10, undefined);
const items: (Input | undefined)[] = [shared, undefined, { label: "record" }, { maxTokens: undefined }];
console.log(latest(items, "maxTokens"), latest(items, "label"));

shared.label = "class";
console.log(latest([items[2], shared], "label"), latest([shared, items[2]], "label"));
console.log(latest([], "maxTokens"), latest([undefined], "label"));

function read(input: Input, key: "maxTokens"): number | undefined {
  return input[key];
}
console.log(read(shared, "maxTokens"), read({}, "maxTokens"), read({ maxTokens: 3 }, "maxTokens"));

const literal = "label";
const chosen: Input | undefined = { label: "const key" };
console.log(chosen?.[literal], shared["label"]);
