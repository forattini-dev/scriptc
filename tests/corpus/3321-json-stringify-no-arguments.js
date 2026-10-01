// @rust-only
// @no-engine
console.log(JSON.stringify() === undefined);
console.log(JSON.stringify(undefined) === undefined);
console.log(JSON.stringify(null));
let calls = 0;
function missing() { calls++; return undefined; }
console.log("effect", JSON.stringify(missing()) === undefined, calls);
console.log("pretty", JSON.stringify(undefined, null, 2) === undefined);
console.log("text", JSON.stringify("undefined"));
const absent = JSON.stringify(undefined);
function encodeMissing() { return JSON.stringify(missing()); }
function observe(value) { console.log("observe", typeof value, value === undefined); }
const record = { value: JSON.stringify(undefined) };
console.log("stored", absent === undefined, encodeMissing() === undefined, record.value === undefined, calls);
const returnedRecord = { value: encodeMissing() };
console.log("returned-record", returnedRecord.value === undefined, calls);
observe(JSON.stringify(undefined));
function spacing() { calls++; return 2; }
console.log("spacing", JSON.stringify(missing(), null, spacing()) === undefined, calls);
function nullRoot() { calls++; return null; }
console.log("null-effect", JSON.stringify(nullRoot(), null, spacing()) === "null", calls);
