const rows = [{ name: "a" }, { name: "b" }];
const alias = rows;
let calls = 0;
function getRows(): { name: string }[] { calls++; return rows; }
getRows().length = 0;
console.log(calls, rows.length, alias.length);
rows.push({ name: "after" });
console.log(alias[0].name, alias.length);
rows.length = 0;
rows.length = 0;
console.log(rows.length);
const numbers = [1, 2, 3];
numbers.length = 0;
numbers.push(4);
console.log(numbers.join(","));
// A user field named length retains ordinary record assignment semantics.
const custom = { length: 2, value: "kept" };
custom.length = 0;
console.log(custom.length, custom.value);
