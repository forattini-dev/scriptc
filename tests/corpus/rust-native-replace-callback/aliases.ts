export {};
function wrap(match: string): string { return "[" + match + "]"; }
const alias = wrap;
const holder = { callback: alias };
console.log("alias", "aba".replace(/a/g, holder.callback));
function defaulted(match: string, capture: string | undefined = "missing"): string {
  return match + ":" + capture;
}
console.log("defaults", "ab".replace(/(z)?/g, defaulted));
function rest(match: string, ...args: any[]): string {
  console.log("rest", args.length, args[0] === undefined, args[1] === 0, args[2] === "b");
  return match;
}
console.log("rest-output", "b".replace(/(a)?b/, rest));
const object = { value: "wrong", callback: function (this: any, match: string): string {
  console.log("this", this === undefined); return match;
} };
console.log("unbound", "a".replace(/a/, object.callback));
