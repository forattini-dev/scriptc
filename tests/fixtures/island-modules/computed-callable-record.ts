interface Core {
  main(argv: string[]): Promise<number>;
}

const specifier = import.meta.url.replace(/\/[^/]+$/, "/computed-core.mjs");
const core = await import(specifier) as Core;

console.log(await core.main(["one", "two"]));
