// @rust-only
// @no-engine
export {};

let regexCalls = 0;
function capture(): RegExp {
  regexCalls++;
  return /^https?:\/\/([^/]+)/;
}

function hostname(url: string | undefined): string {
  return url?.match(capture())?.[1] ?? "missing";
}

console.log(hostname(undefined), regexCalls);
console.log(hostname("https://example.com/path"), regexCalls);
console.log(hostname("not a url"), regexCalls);

type Context = { isStartPage: boolean; url?: string };
function homepage(ctx: Context): boolean {
  return ctx.isStartPage || !!ctx.url?.match(/^https?:\/\/[^/]+\/?$/);
}
console.log(homepage({ isStartPage: false }), homepage({ isStartPage: false, url: "https://example.com/" }));
