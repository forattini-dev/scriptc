console.log(["true"].indexOf(true), ["0"].includes(0));
console.log([false].indexOf(0), [false].includes("false", 0));
console.log([undefined].indexOf(0), [null].includes(undefined));
console.log([[]].indexOf(0), [[1]].includes("1"));
console.log([1n].indexOf(1), [1].includes(1n));
console.log(["true", "other"].indexOf(true, 1));
let effects = 0;
function needle() { effects++; return true; }
function start() { effects++; return 0; }
console.log(["true"].indexOf(needle(), start()), effects);
const sparse = ["one"];
sparse[3] = "four";
console.log(sparse.includes(undefined, 1), sparse.indexOf(undefined, 1));
