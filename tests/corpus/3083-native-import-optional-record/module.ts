export interface Options {
  aliases?: string[];
  fail?: boolean;
}
export async function run(options: Options): Promise<void> {
  if (options.fail) throw new Error("module");
  const aliases = options.aliases;
  if (aliases !== undefined) {
    aliases.push("module");
    console.log("module", aliases.join(","));
  }
  await Promise.resolve();
  options.aliases = undefined;
}
