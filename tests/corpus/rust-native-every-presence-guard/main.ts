interface Entry {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
}

function parseTable(raw: string): Map<number, Entry> {
  const table = new Map<number, Entry>();
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) continue;
    const [pid, ppid, rss] = fields.map(Number);
    if (![pid, ppid, rss].every((value) => value != null && Number.isSafeInteger(value) && value >= 0)) continue;
    table.set(pid!, { pid: pid!, ppid: ppid!, rssBytes: rss! * 1024 });
  }
  return table;
}

const table = parseTable("  1   0  100\nheader x y\n 42  1  7\n-3 1 2\n 9 42 5.5\n 7 1 3");
for (const [pid, entry] of table) {
  console.log(pid, entry.ppid, entry.rssBytes);
}
console.log(table.size);

function firstPresent(values: readonly (string | undefined)[]): string {
  const [a, b] = values;
  if ([a, b].every((value) => value !== undefined)) {
    return `${a!.toUpperCase()}${b!.length}`;
  }
  return "missing";
}
console.log(firstPresent(["x", "yy"]), firstPresent(["x"]));
