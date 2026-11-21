type Entry = { kind: string; value: number };

const input: Entry[] = [
  { kind: "keep", value: 7 },
  { kind: "drop", value: 2 },
];
const filtered = input.filter((entry) => entry.value > 0);
const sections = [
  { kind: "root", value: 0 },
  ...filtered.map((entry) => ({ kind: entry.kind, value: entry.value })),
];

function isKept(entry: (typeof sections)[number]): boolean {
  return entry.kind === "keep";
}

const found = sections.find(isKept);
console.log(found === undefined ? "missing" : `${found.kind}:${found.value}`);
