const signature = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
let total = 0;
for (let i = 0; i < signature.length; i++) total += signature[i];
console.log(total);
const names: [string, string, string] = ["a", "b", "c"];
let calls = 0;
function getNames(): [string, string, string] { calls++; return names; }
function index(): number { names[1] = "after"; return 1; }
console.log(getNames()[index()], calls);
const flags = [true, false, true] as const;
for (let i = 0; i < flags.length; i++) console.log(flags[i]);
