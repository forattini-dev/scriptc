// @ts-nocheck
export {};
function auth(value: number): number { return value + 3; }
auth.VERSION = "1.0";
const alias = auth;
console.log("first", auth.VERSION === "1.0", alias.VERSION === "1.0", alias === auth, alias(4));
alias.VERSION = "2.0";
const erased: any = auth;
console.log("shared", auth.VERSION === "2.0", erased.VERSION === "2.0", erased === auth);
erased.VERSION = 9;
console.log("owning", auth.VERSION === 9, alias.VERSION === 9, auth(1));
const captured = (): any => auth.VERSION;
console.log("capture", captured() === 9);
console.log("missing", erased.missing === undefined);
const snapshot = auth.VERSION;
delete erased.VERSION;
const absent = auth.VERSION;
console.log("snapshot", snapshot === 9, absent === undefined, auth.VERSION === undefined, alias(2));
