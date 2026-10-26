// @rust-only
// @no-engine
export {};
const regex = /a/gy;
const first = regex.exec("aa");
console.log(first !== null, regex.lastIndex);
const second = regex.exec("aa");
console.log(second !== null, regex.lastIndex);
console.log(regex.exec("aa") === null, regex.lastIndex);
if (first !== null && second !== null) console.log(first !== second, first.index, second.index, first[0], second[0]);
regex.lastIndex = 0.7;
console.log(regex.exec("aa") !== null, regex.lastIndex);
regex.lastIndex = Number.POSITIVE_INFINITY;
console.log(regex.exec("aa") === null, regex.lastIndex);
const plain = /a/; plain.lastIndex = 8;
console.log(plain.exec("a") !== null, plain.lastIndex);
const empty = /(?:)/g;
console.log(empty.exec("a") !== null, empty.lastIndex, empty.exec("a") !== null, empty.lastIndex);
