function show(groups: NonNullable<RegExpExecArray["groups"]>): void {
  console.log(groups.tail === undefined, groups.tail ?? "absent", JSON.stringify(groups));
}
const missing = /(?<head>x)(?<tail>y)?/.exec("x")!;
const empty = /(?<head>x)(?<tail>y*)/.exec("x")!;
show(missing.groups!);
show(empty.groups!);
console.log(missing[2], empty[2], missing[2] === undefined, empty[2] === "");
const alias = missing;
missing[2] = "updated";
console.log(alias === missing, alias[2], JSON.stringify([...alias]), alias.join("|"));
// An empty capture in the first alternative must win over an absent second one.
const duplicate = /(?<value>a*)x|(?<value>b)y/.exec("x")!;
console.log(duplicate.groups!.value === "", JSON.stringify(duplicate.groups!));
for (const row of "x xy".matchAll(/(?<head>x)(?<tail>y)?/g)) {
  const { tail = "default" } = row.groups!;
  console.log(row.index, tail, row.groups!.tail === undefined);
}
