// @no-engine
const nulls: Record<string, null> = { value: null };
const absent: Record<string, undefined> = { value: undefined };
nulls.extra = null;
absent.extra = undefined;
console.log("nulls", Object.keys(nulls).join(","), JSON.stringify(nulls));
console.log("undefined", Object.keys(absent).join(","), JSON.stringify(absent));
console.log("values", nulls.value === null, absent.value === undefined);
