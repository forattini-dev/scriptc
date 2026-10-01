// @rust-only
// @no-engine
interface Seed { a: number; b: number }
interface Options { a: number; b: number; names: string[] | undefined }
function seed(reverse: boolean): Seed {
  if (reverse) return { b: 2, a: 1 };
  return { a: 1, b: 2 };
}
function build(): Options { return { ...seed(true), names: [] }; }
const options = build();
const names = options.names ?? [];
names.push("ok");
console.log(Object.keys(options).join(","), JSON.stringify(options));
console.log(names.length, options.names?.length);
