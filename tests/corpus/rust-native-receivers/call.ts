// @rust-only
// @no-engine
export {};
function inspect(this: any, label: string): string {
  console.log("receiver", label, typeof this, this === undefined, this === null);
  return label;
}
console.log(inspect.call({ value: 7 }, "object"));
inspect.call(undefined, "undefined");
inspect.call(null, "null");
inspect.call(42, "number");
inspect.call("text", "string");
inspect.call(false, "boolean");
inspect("bare");
const alias = inspect;
alias.call({ value: 8 }, "alias");
const values: string[] = ["apply"];
inspect.apply({ value: 9 }, values as [string]);
const bound = inspect.bind({ value: 10 }, "bound");
bound();
bound.call(undefined);
