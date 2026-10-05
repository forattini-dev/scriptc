// @rust-only
// @no-engine

const empty = new Array();
console.log("empty", empty.length, empty.join("|"));
console.log("items", new Array("3").join("|"), Array(1, "x", null, undefined).join("|"));
const count = Array(JSON.parse("3"));
console.log("count", count.length, 0 in count, count[0] === undefined, count.join("|"));
const item = new Array(JSON.parse('"3"'));
console.log("item", item.length, 0 in item, item.join("|"));
const nullItem = new Array(JSON.parse("null"));
console.log("null", nullItem.length, 0 in nullItem, nullItem[0] === null);
