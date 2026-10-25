// @rust-only
// @no-engine
// @ts-nocheck
export {};
const data: any[] = [1, undefined, 3];
const alias = data;
function keys(value: any): string { return Object.keys(value).join(","); }
function own(value: any, key: string): boolean { return Object.hasOwn(value, key); }
console.log("before", keys(data), data.length);
console.log("delete", delete data[0], delete data[1], delete data[99]);
console.log("holes", own(alias, "0"), own(alias, "1"), alias[0] === undefined, alias[1] === undefined);
console.log("after", keys(alias), alias.length, String(JSON.stringify(alias)));
function put(value: any): void { value[0] = 7; }
put(data);
console.log("insert", keys(alias), alias[0] === 7);
const parsed = JSON.parse('[4,5]');
console.log("parsed", delete parsed[0], parsed.length === 2, String(JSON.stringify(parsed)));
