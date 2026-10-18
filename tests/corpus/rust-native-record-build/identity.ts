const nested = { count: 1 };
const values = ["a"];
const callback = (text: string) => text + "!";
const source = { nested, values, callback, tag: "old" };
const copy = { ...source };
console.log("case", copy !== source, copy.nested === nested, copy.values === values, copy.callback === callback, copy.callback("x"));
copy.nested.count = 2;
copy.values.push("b");
source.tag = "new";
console.log("case", nested.count, values.join("|"), copy.tag, source.tag);
function capture(input: typeof source): () => typeof source {
  const copied = { ...input };
  return () => copied;
}
const get = capture(source);
console.log("case", get() === get(), get().callback === callback, get().nested === nested);
