// A nonparticipating capture is undefined; an empty participating one is "".
function inspect(match: RegExpMatchArray | null): void {
  if (match === null) { console.log("no match"); return; }
  const alias = match;
  console.log(alias.length, alias[0], alias[1] === undefined, alias[2] === undefined);
  console.log(JSON.stringify(alias), alias[2] ?? "fallback");
}
const flag = /^-([^-=])(?:=([\s\S]*))?$/;
inspect(flag.exec("-f"));
inspect(flag.exec("-f="));
inspect(flag.exec("-f=name"));
inspect(flag.exec("--no"));
inspect("-f".match(flag));
for (const row of "a ab".matchAll(/a(b)?/g)) {
  console.log(row.index, row[1] === undefined, JSON.stringify(row));
}
function consume(argv: string[]): void {
  const match = flag.exec(argv[0]);
  if (match === null) return;
  let raw = match[2];
  let index = 0;
  if (raw === undefined) { raw = argv[1]; index += 1; }
  console.log(raw, index);
}
consume(["-f", "name"]);
consume(["-f=", "name"]);
