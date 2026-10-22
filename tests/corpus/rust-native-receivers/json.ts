// @rust-only
// @no-engine
export {};
const source = { value: 2, nested: { value: 3 } };
const text = JSON.stringify(source, function(this: any, key: string, value: any): any {
  console.log("replacer", key, this === source, this === source.nested, this[key] === value);
  return value;
});
console.log("text", text);
const parsed: any = JSON.parse(text);
console.log("parsed", (parsed.nested.value as number));
const hooked: any = { value: 7, toJSON: function(this: { value: number }, key: string): any { return this.value + 1; } };
console.log("hook", JSON.stringify(hooked) as string);
