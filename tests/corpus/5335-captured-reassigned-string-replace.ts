// @rust-only
// @no-engine
export {};

type Context = { result: { positional: Record<string, string | string[]> } };
type Page = { url: string; status: number };

function normalizeUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function summarize(ctx: Context, pages: Page[]): Array<{ url: string; absolute: boolean; status: number }> {
  let url = ctx.result.positional.url as string;
  if (!url) return [];
  url = normalizeUrl(url);
  return pages.slice(0, 10).map((page) => ({
    url: page.url.replace(url, ""),
    absolute: url.startsWith("https://"),
    status: page.status,
  }));
}

async function summarizeAsync(ctx: Context, pages: Page[]): Promise<Array<{ url: string; absolute: boolean; status: number }>> {
  let url = ctx.result.positional.url as string;
  if (!url) return [];
  url = normalizeUrl(url);
  await Promise.resolve("ready");
  return pages.slice(0, 10).map((page) => ({
    url: page.url.replace(url, ""),
    absolute: url.startsWith("https://"),
    status: page.status,
  }));
}

console.log(JSON.stringify(summarize(
  { result: { positional: { url: "https://example.test/" } } },
  [
    { url: "https://example.test/a", status: 200 },
    { url: "https://example.test/b", status: 404 },
  ],
)));

async function main(): Promise<void> {
  console.log(JSON.stringify(await summarizeAsync(
    { result: { positional: { url: "https://example.test/" } } },
    [{ url: "https://example.test/c", status: 201 }],
  )));
}
void main();
