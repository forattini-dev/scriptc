function count(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return 0;
}

console.log(count("café"), count(42));
