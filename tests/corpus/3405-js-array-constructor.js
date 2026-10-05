// @rust-only
// @no-engine

const chars = new Array(3);
console.log("holes", chars.length, 0 in chars, chars[0] === undefined);
chars[2] = "c";
chars[0] = "a";
console.log("written", chars.length, 0 in chars, 1 in chars, 2 in chars, chars.join("|"));
chars[5] = "f";
console.log("grown", chars.length, 3 in chars, 4 in chars, 5 in chars, chars.join(""));
