// @rust-only
// @no-engine
export {};
const regex = /😀(.)/gu;
const input = "a😀z😀q";
const first = regex.exec(input);
if (first !== null) console.log(first.index, first.input === input, first[1] === "z", regex.lastIndex);
const second = regex.exec(input);
if (second !== null) console.log(second.index, second[1] === "q", regex.lastIndex);
console.log(regex.exec(input) === null, regex.lastIndex);
let calls = 0;
function base(): RegExp { calls++; return /a/g; }
function subject(): string { calls = calls * 10 + 2; return "a"; }
const match = base().exec(subject());
console.log(calls, match !== null);
