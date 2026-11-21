const text: any = "alpha.beta..gamma.";
const split: any = text["split"];
console.log(typeof split);
console.log(split === text["split"]);
const parts: any = text.split(".");
console.log(Number(parts.length));
console.log(String(parts[0]));
console.log(String(parts[2]));
console.log(String(parts[4]));
const limited: any = text.split(".", 2);
console.log(Number(limited.length));
console.log(String(limited[1]));
const noSeparator: any = text.split();
console.log(Number(noSeparator.length));
console.log(String(noSeparator[0]));
const zero: any = text.split(undefined, 0);
console.log(Number(zero.length));
const nullText: any = "anullb";
const nullSeparator: any = nullText.split(null);
console.log(Number(nullSeparator.length));
console.log(String(nullSeparator[1]));
const unicode: any = "A😀";
const chars: any = unicode.split("");
console.log(Number(chars.length));
const called: any = split.call("x-y", "-");
console.log(String(called[1]));
const regexText: any = "a1b2c";
const regex: any = regexText.split(/[0-9]/, 2);
console.log(Number(regex.length));
console.log(String(regex[1]));
const custom: any = {};
custom[Symbol.split] = (subject: any, limit: any) => String(subject) + ":" + String(limit);
console.log(String(text.split(custom, 2)));
console.log(String(split.call(42, custom, 3)));
try {
  split.call(null, ".");
} catch (error) {
  console.log(error instanceof TypeError);
}
