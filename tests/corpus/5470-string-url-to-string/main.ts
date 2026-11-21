function serialize(value: string | URL): string {
  const text = value.toString();
  return `${text.length}:${text}`;
}

console.log(serialize("plain"));
console.log(serialize(new URL("https://example.com/a b?q=two words")));
