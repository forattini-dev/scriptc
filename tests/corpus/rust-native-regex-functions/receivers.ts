// @rust-only
// @no-engine
const regex = /a/gy;
const other = /b/g;
const test = regex.test;
console.log(test.call(regex, "aa"), regex.lastIndex);
console.log(test.call(regex, "aa"), regex.lastIndex);
console.log(test.call(regex, "aa"), regex.lastIndex);
console.log(test.call(other, "ab"), other.lastIndex, regex.lastIndex);
const bound = test.bind(regex);
console.log(bound.call(other, "aa"), regex.lastIndex, other.lastIndex);
function invoke(callback: (value: any) => boolean): boolean { return callback("aa"); }
console.log(invoke(bound), regex.lastIndex);
regex.lastIndex = 0;
console.log(test.apply(regex, ["aa"]), regex.lastIndex);
