// @rust-only
// @no-engine
export {};
function unit(text: string, index: number): string | undefined { return text[index]; }
const text = "A\u{1f600}Z";
const high: string = JSON.parse('"\\ud83d"');
const low: string = JSON.parse('"\\ude00"');
const isolated: string = JSON.parse('"\\ud800"');
console.log("ascii", unit(text, 0) === "A", unit(text, 3) === "Z");
console.log("utf16", unit(text, 1) === high, unit(text, 2) === low);
console.log("isolated", unit(isolated, 0) === isolated);
console.log("missing", unit(text, 4) === undefined, unit("", 0) === undefined, unit(text, -1) === undefined);
console.log("numeric", unit(text, -0) === "A", unit(text, 1.5) === undefined, unit(text, Number.NaN) === undefined, unit(text, Number.POSITIVE_INFINITY) === undefined);
console.log("large", unit(text, 4294967295) === undefined, unit(text, 9007199254740991) === undefined);
