const missing: any = undefined;
const nil: any = null;
console.log("absent", "abc".match(missing)?.[0], "null".match(nil)?.[0]);
