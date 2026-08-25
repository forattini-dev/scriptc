// The static string surface: case mapping, split into a string[] flowing
// into intrinsic array ops, padding, string-pattern replacement,
// trimming, and in-range at().
const s = "  Hello, World  ";
console.log(s.toUpperCase() + "|", s.toLowerCase() + "|");
console.log(s.trimStart() + "|", s.trimEnd() + "|", s.trim().length);
const csv = "a,b,c,d";
const parts = csv.split(",");
console.log(parts.length, parts.indexOf("c"), parts.includes("e"), parts.join("-"));
console.log("one".split(",").length, "one".split(",")[0], "".split(",").length);
console.log("5".padStart(3, "0"), "5".padEnd(3, "0"), "abcdef".padStart(3, "x"));
console.log("v".padStart(6, "ab"), "v".padEnd(6, "ab"));
console.log("banana".replace("an", "AN"), "banana".replaceAll("an", "AN"));
console.log("banana".replaceAll("na", ""), "aaa".replace("", "b"), "aaa".replaceAll("x", "y"));
console.log("abc".replace("b", "[$&]-$`-$'-$$-$1-$<x>"));
console.log("aba".replaceAll("a", "<$`|$&|$'>"));
console.log("😀".replaceAll("", "-"), "😀".replaceAll("", ""));
console.log("aaaa".replaceAll("aa", "x"), "aaa".replaceAll("aa", "x"));
let replacementOrder = "";
function replacementOperand(label: string, value: string): string {
  replacementOrder = replacementOrder + label;
  return value;
}
console.log(
  replacementOperand("r", "aba").replaceAll(
    replacementOperand("s", "a"),
    replacementOperand("t", "x"),
  ),
  replacementOrder,
);
console.log("hello".at(0), "hello".at(4), "hello".at(-1), "hello".at(-5));
console.log("A🎉Z".at(1), "A🎉Z".at(-2), "hello".at(1.9), "hello".at(NaN));
// Chains across the static and island halves keep their static types.
const words = "mixed case words".toUpperCase().split(" ");
console.log(words.length, words[0], words.join("_").padEnd(20, "!"));
console.log(words[1].toLowerCase().repeat(2).indexOf("sec"));
