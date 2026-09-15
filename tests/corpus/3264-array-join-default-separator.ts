// Array.prototype.join with no argument uses "," as the separator.
const nums: number[] = [1, 2.5, -3];
const words: string[] = ["alpha", "beta", ""];
const flags: boolean[] = [true, false];
const maybe: (string | undefined)[] = ["a", undefined, "c"];
const empty: string[] = [];

console.log(nums.join());
console.log(words.join());
console.log(flags.join());
console.log(maybe.join());
console.log(`[${empty.join()}]`);
console.log(nums.join() === nums.join(","));
console.log(["x"].join().length);
