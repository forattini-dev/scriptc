// @rust-only
const source = new Set<string>(["a", "b", "a"]);
source.delete("a");
source.add("a");
let calls = 0;
function getSource(): ReadonlySet<string> { calls++; return source; }
const copy = new Set(getSource());
copy.delete("b");
copy.add("c");
console.log([...source].join(","), [...copy].join(","), calls);
const mimes = ["image/png", "image/jpeg", "image/png"] as const;
console.log([...new Set<string>(mimes)].join(","));
const points = new Set("a😀a🦀");
console.log([...points].join(","));
const item = { id: 1 };
const records = new Set([item]);
const recordCopy = new Set(records);
console.log(recordCopy.has(item));
item.id = 2;
console.log([...recordCopy][0].id);
console.log(new Set(new Set<number>()).size);
