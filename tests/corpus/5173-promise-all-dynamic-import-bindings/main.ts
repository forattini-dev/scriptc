async function main(): Promise<void> {
  const [{ first }, { second }, namespace] = await Promise.all([
    import("./a.ts"),
    import("./b.ts"),
    import("./b.ts"),
  ]);
  console.log(first());
  console.log(second());
  console.log(namespace.second());
}

void main();
