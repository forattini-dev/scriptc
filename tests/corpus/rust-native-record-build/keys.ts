type Item = { tag: string; option?: string; callback?: (text: string) => string };
const absent: Item = { tag: "absent" };
const present: Item = { tag: "present", option: undefined };
function copy(input: Item): Item { return { ...input }; }
console.log("case", Object.hasOwn(copy(absent), "option"), Object.hasOwn(copy(present), "option"));
const callback = (text: string) => text;
const copied = copy({ callback, tag: "callback" });
console.log("case", copied.callback === callback, Object.keys(copied).join("|"));
const numeric = { "10": "ten", z: "z", "2": "two", a: "a" };
const ordered = { prefix: "p", ...numeric, suffix: "s" };
console.log("case", Object.keys(ordered).join("|"), ordered[2], ordered[10]);
const __proto__ = "own";
const own = { __proto__ };
const protoCopy = { ...own };
console.log("case", Object.hasOwn(protoCopy, "__proto__"), protoCopy.__proto__ === "own", Object.keys(protoCopy).join("|"));
const overwritten = { ...present, ...absent };
console.log("case", overwritten.tag, Object.hasOwn(overwritten, "option"), Object.keys(overwritten).join("|"));
