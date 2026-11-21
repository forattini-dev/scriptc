function snapshot(values: readonly string[]): string[] {
  const copied = [...values];
  copied.push("tail");
  return copied;
}

const source: readonly string[] = ["first", "second"];
console.log(snapshot(source).join(","));
console.log(source.join(","));
