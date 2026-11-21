function text(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return value.toString();
  }
  return "other";
}

console.log(text(42));
console.log(text(true));
console.log(text("ok"));
console.log(text(12n));
