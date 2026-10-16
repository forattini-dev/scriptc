// @rust-only
// @no-engine
var noop = () => Promise.resolve();
const first = noop();
console.log("identity", first === first, first !== noop(), Promise.resolve(first) === first);
const erased: unknown = first;
console.log("erased", erased === first);
noop().then((value) => { console.log("void", value === undefined); });
const number = Promise.resolve(7);
number.then((value) => { console.log("number", value + 1); return value + 2; }).then((value) => { console.log("mapped", value); });
const object = { value: "original" };
const promised = Promise.resolve(object);
object.value = "mutated";
promised.then((value) => { console.log("record", value === object, value.value); });
Promise.resolve("text").then((value) => { console.log("string", value); });
Promise.resolve(null).then((value) => { console.log("null", value === null); });
Promise.resolve(undefined).then((value) => { console.log("undefined", value === undefined); });
function factory(): Promise<number> { return Promise.resolve(4); }
const alias = factory;
alias().then((value) => { console.log("factory", value); });
const map = new Map();
map.set(first, "promise-key");
console.log(map.get(first) === "promise-key", map.get(noop()) === undefined);
console.log("sync", "end");
