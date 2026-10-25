// @rust-only
// @no-engine
console.log("bigint JSON", '"9007199254740993n", "-123n"'.replace(/"(-?\d+)n"/g, "$1"));
console.log("first/all", "aba".replace(/a/, "x"), "aba".replace(/a/g, "x"), "aba".replaceAll(/a/g, "x"));
console.log("captures", "abc".replace(/(a)(b)/, "$2$1/$&/$$/$0/$3/$12"));
console.log("context", "abc".replace(/b/, "$`/$'"));
console.log("optional", "b".replace(/(a)?b/, "[$1]"));
console.log("named", "abc".replace(/(?<first>a)(?<second>b)/, "$<second>$<first>/$<missing>"));
console.log("literal search", "aba".replace("a", "x"), "aba".replaceAll("a", "x"));
console.log("no match", "abc".replace(/z/g, "x"));
const units = "😀".replace(/(?:)/g, "-");
const unicode = "😀".replaceAll(/(?:)/gu, "-");
console.log("zero width", units.length, units.charCodeAt(1), units.charCodeAt(3), unicode, unicode.length);
const lone = "😀".slice(0, 1);
const result = lone.replace(/z/, "x");
console.log("unpaired identity", result === lone, result.charCodeAt(0));
