type Entry = { kind: "host"; value: string } | { kind: "file"; path: string };
const original: { kind: "host"; value: string }[] = [{ kind: "host", value: "first" }];
const widened: readonly Entry[] = original;
original.push({ kind: "host", value: "second" });
console.log(widened.length);
