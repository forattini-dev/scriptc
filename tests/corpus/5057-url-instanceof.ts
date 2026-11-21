/// <reference lib="dom" />

function describe(input: string | URL | { url?: unknown }): string {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : typeof input.url === "string"
    ? input.url
    : "request";
  return new URL(url).pathname;
}

console.log(describe(new URL("https://example.com/a")));
