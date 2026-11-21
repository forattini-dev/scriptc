interface Entry {
  alias?: string;
  spec: string;
}

function required(): Array<{ alias: string; spec: string }> {
  return [{ alias: "native", spec: "rust" }];
}

const entries: Entry[] = [
  ...required(),
  { spec: "compiler" },
];

console.log(`${entries[0]!.alias}:${entries[0]!.spec}`);
console.log(`${entries[1]!.alias ?? "missing"}:${entries[1]!.spec}`);
