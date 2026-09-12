interface Core {
  main(argv: string[]): Promise<number>;
}

// Native callers can locate runtime assets beside the executable explicitly.
const base = process.argv[2] ?? import.meta.url;
const specifier = base.replace(/\/[^/]+$/, "/computed-core.mjs");
const core = await import(specifier) as Core;

console.log(await core.main(["one", "two"]));
