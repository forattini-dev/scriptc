// Array.prototype methods on erased arrays (values parsed from JSON).
const data = JSON.parse('{"checks":[{"name":"home","ok":true,"tags":["a","b"]},{"name":"socket","ok":false,"tags":[]},{"name":"unit","ok":true,"tags":["c"]}],"nested":[1,[2,[3,[4]]],5],"nums":[4,1,3,2],"words":["x","y","z"]}');
const { checks, nested, nums, words } = data;

console.log(JSON.stringify(checks.filter((check) => check.ok).map((check) => check.name)));
console.log(checks.find((check) => !check.ok).name, checks.findIndex((check) => check.name === "unit"));
console.log(checks.find((check) => check.name === "none"), checks.findIndex(() => false));
console.log(checks.findLast((check) => check.ok).name, checks.findLastIndex((check) => check.ok));
const seen = [];
console.log(checks.forEach((check, index) => seen.push(`${index}:${check.name}`)), seen.join(" "));
console.log(JSON.stringify(checks.flatMap((check) => check.tags)));
console.log(JSON.stringify(checks.flatMap((check) => check.name)));
console.log(JSON.stringify(nested.flat()), JSON.stringify(nested.flat(2)), JSON.stringify(nested.flat(Infinity)));
console.log(words.includes("y"), words.includes("q"), words.includes("x", 1), JSON.parse("[0]").map(() => 0 / 0).includes(NaN));
console.log(JSON.stringify(words.slice(1)), JSON.stringify(words.slice(-2, -1)), JSON.stringify(words.slice()));
console.log(nums.reduce((sum, value) => sum + value, 0), nums.reduce((max, value) => (value > max ? value : max)));
try {
  JSON.parse("[]").reduce((a, b) => a + b);
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
console.log(JSON.stringify(words.concat(["w"], "v", [["u"]])));
console.log(words.at(0), words.at(-1), words.at(5));
const holder = { suffix: "!" };
console.log(JSON.stringify(words.filter(function (word) { return word + this.suffix !== "y!"; }, holder)));
