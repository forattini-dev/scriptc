var splice = [].splice;
/** @type {any[]} */
var values = ["first", "last"];
// @ts-ignore Exercise the JavaScript one-argument splice call ABI.
var removed = splice.call(values, -1);
console.log(removed[0] + "|" + values.join(","));
