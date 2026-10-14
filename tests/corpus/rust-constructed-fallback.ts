function words(flag: boolean): string[] | undefined { return flag ? ["yes"] : undefined; }
function record(flag: boolean): { name: string } | undefined { return flag ? { name: "yes" } : undefined; }
for (const flag of [false, true]) {
  const nullish = words(flag) ?? [];
  const truthy = words(flag) || [];
  const object = record(flag) ?? { name: "fallback" };
  nullish.push("tail");
  console.log(nullish.join(","), truthy.length, object.name);
}
