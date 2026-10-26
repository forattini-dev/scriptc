// @rust-only
// @no-engine
// @ts-nocheck
export {};
const text = "abc";
console.log("literal", text["0"] === "a", text["2"] === "c", text["length"] === 3);
console.log("spelling", text["01"] === undefined, text["-0"] === undefined, text["0x1"] === undefined, text["1e0"] === undefined, text[""] === undefined);
console.log("other", text["absent"] === undefined, text["NaN"] === undefined, text["Infinity"] === undefined);
let index = 1, flag = true, big = 2n;
console.log("conversion", text[index as unknown as string] === "b", text[flag] === undefined, text[big] === "c", text[null] === undefined, text[undefined] === undefined);
