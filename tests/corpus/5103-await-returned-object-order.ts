function mark(label: string): string {
  console.log(label);
  return label;
}

async function result(): Promise<{ first: string; second: string; third: string; fourth: string }> {
  if (false) console.log("unreachable");
  return {
    first: mark("first"),
    second: await Promise.resolve(mark("second")),
    third: await Promise.resolve(mark("third")),
    fourth: mark("fourth"),
  };
}

async function main(): Promise<void> {
  const value = await result();
  console.log(`${value.first},${value.second},${value.third},${value.fourth}`);
}
void main();
