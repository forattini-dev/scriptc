async function fill(mode: number): Promise<string> {
  const box = { data: "" };
  if (mode === 0) {
    box.data = await Promise.resolve("a");
  }
  if (mode === 1) {
    box.data = mode === 1 ? await Promise.resolve("b") : "x";
  }
  if (mode === 2) {
    throw new Error("unused");
  }
  return box.data;
}

async function main(): Promise<void> {
  const values = await Promise.all([fill(0), fill(1)]);
  console.log(values.join(","));
}

void main();
