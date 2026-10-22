// @rust-only
// @no-engine
var item: {value: number} | undefined;
console.log("missing", `${item && item.value}`);
item = {value: 8};
console.log("present", `${(item) && item.value}`);
console.log("comparison", `${item !== undefined && item.value}`);
function read(value: {value: number} | undefined): any { return value && value.value; }
console.log("union", `${read(undefined)}`, `${read({value: 3})}`);
