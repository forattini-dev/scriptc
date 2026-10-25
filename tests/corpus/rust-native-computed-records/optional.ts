// @rust-only
// @no-engine
// @ts-nocheck
export {};
let calls = 0;
function key(): string { calls++; return "value"; }
function read(value: {value: number} | undefined) { return value?.[key()]; }
console.log("absent", read(undefined) === undefined, calls === 0);
console.log("present", read({value: 8}) === 8, calls === 1);
const data = {value: {text: "ok"}};
function name(): string { return "value"; }
console.log("chain", data?.[name()]?.text === "ok");
let missing = "absent";
console.log("missing", data?.[missing] === undefined, data["absent"] === undefined);
