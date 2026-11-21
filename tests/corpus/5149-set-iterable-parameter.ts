function writeLedger(applied: Iterable<string>): void {
  console.log([...applied].sort().join(","));
}

const done = new Set<string>(["migration-b", "migration-a"]);
writeLedger(done);
