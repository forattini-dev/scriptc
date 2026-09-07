const labels = ["native", "safe", "native"] as const;
const values = "12😀";
const charset = [...new Set([...labels.join(""), ...values])].sort().join("");
console.log(charset);
const ordered = [...new Set([...["b", "a"], "b", ..."ac"])];
console.log(ordered.join(","));
const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
console.log(numbers.join(":"));
const mutable: [string, string] = ["before", "second"];
let calls = 0;
function tuple(): [string, string] { calls++; return mutable; }
function separator(): string { mutable[0] = "after"; return "|"; }
console.log(tuple().join(separator()), calls);
console.log(([true, false] as const).join());
