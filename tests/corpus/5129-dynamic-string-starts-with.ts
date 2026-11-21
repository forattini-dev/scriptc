const text: any = "alpha😀omega";
const startsWith: any = text["startsWith"];

console.log(typeof startsWith);
console.log(startsWith === text.startsWith);
console.log(Boolean(text.startsWith("alpha")));
console.log(Boolean(text.startsWith("😀", 5)));
console.log(Boolean(text.startsWith("omega", 7)));
console.log(Boolean(text.startsWith("omega", "7")));
console.log(Boolean(text.startsWith("alpha", -10)));
console.log(Boolean(text.startsWith("", Infinity)));
console.log(Boolean(startsWith.call(421, "42")));
console.log(Boolean(text.startsWith()));
const slice: any = text.slice;
console.log(String(text.slice(5, 7)));
console.log(String(text.slice(-5)));
console.log(String(slice.call(421, 1)));

try {
  startsWith.call(null, "x");
} catch (error) {
  console.log(error instanceof TypeError);
}
