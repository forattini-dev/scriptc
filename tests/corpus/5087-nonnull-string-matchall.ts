const match = /members\s*=\s*\[([\s\S]*?)\]/m.exec('members = ["one", "two"]');
if (match === null) throw new Error("missing");
const values: string[] = [];
for (const item of match[1]!.matchAll(/["']([^"']+)["']/g)) {
  values.push(item[1]!);
}
console.log(values.join(","));
