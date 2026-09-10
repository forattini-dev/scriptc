// @rust-only
// @no-engine
const ns = await import("./module.ts");
const nested = ns.nested;
const child = nested.child;
nested.child.count = 4;
const returned = await ns.nestedState();
console.log("nested", returned === nested, returned.child === child, returned.child.count);
returned.child.count = 5;
console.log("nested write", child.count);
const indexed = ns.indexedState();
console.log("indexed", indexed === ns.indexed, indexed.count);
ns.updateIndexed(indexed);
console.log("indexed write", ns.indexed.count);
indexed.extra = 9;
const second = ns.indexedState();
console.log("indexed key", second.extra);
const wide = { count: 1, values: [1, 2] };
const values = wide.values;
ns.increment(wide);
await ns.append(wide);
console.log("wide", wide.count, wide.values === values, values.join(","));
export {};
