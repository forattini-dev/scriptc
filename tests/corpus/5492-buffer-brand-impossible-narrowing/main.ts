function normalize(key: string, value: string): string {
  const keyText = Buffer.isBuffer(key) ? key.toString() : key;
  const valueText = Buffer.isBuffer(value) ? value.toString() : value;
  return `${keyText.toLowerCase()}:${valueText}`;
}

console.log(normalize("X-Header", "Value"));
const names: string[] = ["a", "b"];
console.log(Buffer.isBuffer(names));
