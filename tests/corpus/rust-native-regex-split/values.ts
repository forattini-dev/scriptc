// @rust-only
// @no-engine
export {};
const sgr = /(\x1b\[[0-9;]*m)/;
const alias = sgr;
const colored = "a\x1b[31mb\x1b[0mc".split(alias);
console.log("ansi", colored.length, colored.join("|"));
console.log("plain", "a,b,,c".split(/,/).join("|"));
console.log("capture", "a1b2c".split(/(\d)/).join("|"));
console.log("empty", "abc".split(/()/).join("|"));
console.log("empty-source", "".split(/()/).length, "".split(/x/).length);
console.log("unicode", "😀x".split(/()/u).join("|"));
const sticky = /(\d)/gy;
sticky.lastIndex = 7;
console.log("sticky", "a1b2c".split(sticky).join("|"), sticky.lastIndex);
