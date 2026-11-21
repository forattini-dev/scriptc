const text: any = "  Alpha😀omega  ";

console.log(Boolean(text.includes("😀", 5)));
console.log(Boolean(text.endsWith("omega  ")));
console.log(String(text.trim()));
console.log(String(text.trimStart()));
console.log(String(text.trimEnd()));
console.log(String(text.toLowerCase()));
console.log(String(text.toUpperCase()));
console.log(String(text.substring(7, 12)));
console.log(String(text.substr(-7, 5)));
console.log(String("ab".repeat(2)));
console.log(String(text.charAt(7)));
console.log(Number(text.charCodeAt(7)));
console.log(Number(text.codePointAt(7)));
console.log(Number(text.indexOf("omega")));
console.log(Number(text.lastIndexOf("a")));
console.log(Number(text.localeCompare(text)));
console.log(Boolean(text.isWellFormed()));
console.log(String(text.toWellFormed()) === text);
console.log(String("7".padStart(3, "0")));
console.log(String("7".padEnd(3, "0")));

const includes: any = text.includes;
console.log(Boolean(includes.call(42142, "14")));
