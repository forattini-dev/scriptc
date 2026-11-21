interface TomlLine {
  readonly text: string;
  readonly eol: string;
}

const lines: TomlLine[] = [{ text: "old", eol: "\n" }];
const line = lines[0]!;
lines[0] = { ...line, text: "new" };
console.log(lines[0]!.text + JSON.stringify(lines[0]!.eol));

const maybe: TomlLine | undefined = lines[0];
const narrowed = maybe!;
const copied: TomlLine = { ...narrowed, text: "again" };
console.log(copied.text + JSON.stringify(copied.eol));
