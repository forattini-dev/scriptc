// @ts-nocheck
export {};
function fn(value: number): number { return value * 2; }
const data: any = fn;
data.z = "z";
data[10] = "ten";
data[2] = "two";
data.a = undefined;
data["01"] = "leading";
console.log("keys", Object.keys(fn).join("|"), Object.hasOwn(fn, "a"), Object.hasOwn(fn, "missing"));
console.log("overwrite", data.z === "z", data[2] === "two");
data.z = "new";
console.log("stable", Object.keys(data).join("|"));
console.log("delete", delete data[2], delete data.z, delete data.missing, Object.hasOwn(data, "2"));
data.z = "last";
console.log("reinsert", Object.keys(fn).join("|"), fn(5), data.z === "last");
console.log("direct", delete fn["01"], Object.keys(fn).join("|"));
