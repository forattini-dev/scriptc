type Row = { event: string } | null;
function notNull<T>(value: T | null): value is T {
  return value !== null;
}

const rows: Row[] = [{ event: "one" }, null, { event: "two" }];
console.log(rows.filter(notNull).map(({ event }) => event).join(","));
