// @rust-only
// @no-engine
export {};
type Replacer = (this: any, key: string | number | undefined, value: any) => any;
const stringify = (root: any, replacer?: Replacer | (string | number)[] | null, space?: string | number): string | undefined => {
  if (typeof replacer === "function") return replacer.call({tag: "holder"}, "key", root) as string;
  return "none";
};
const replacer: Replacer = function(this: { tag: string }, key, value): any { console.log("callback", typeof key, value === "value"); return this.tag; };
console.log("contract", stringify("value", replacer) === "holder", stringify("value") === "none", stringify("value", null) === "none", stringify("value", [1, "key"]) === "none");
