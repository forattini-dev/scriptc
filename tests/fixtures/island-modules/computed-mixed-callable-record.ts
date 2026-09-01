interface Core {
  main(argv: string[]): Promise<number>;
  renderAutomaticCommandOutput(
    stdout: Uint8Array,
    command: string,
    level?: "silent" | "brief" | "full",
  ): Promise<Uint8Array>;
  renderCliFailure(error: unknown): { output: Uint8Array; status: number };
}

const specifier = import.meta.url.replace(/\/[^/]+$/, "/computed-core.mjs");
const core = await import(specifier) as Core;

console.log(await core.main(["one", "two"]));
const rendered = await core.renderAutomaticCommandOutput(
  Buffer.from("out"),
  "build",
);
console.log(Buffer.from(rendered).toString());
const failure = core.renderCliFailure("boom");
console.log(`${failure.status}:${Buffer.from(failure.output).toString()}`);
