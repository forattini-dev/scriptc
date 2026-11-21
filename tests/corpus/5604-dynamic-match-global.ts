const pattern: any = /a/g;
const result: any = "banana".match(pattern);
console.log("global", result.join(","), pattern.lastIndex);
