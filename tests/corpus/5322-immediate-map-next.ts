const values = new Map<string, string>();
values.set("first", "one");
values.set("second", "two");

const oldest = values.keys().next();
console.log(oldest.done, oldest.value);

const empty = new Map<string, string>().keys().next();
console.log(empty.done, empty.value);
