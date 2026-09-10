// @rust-only
// @no-engine
interface BooleanFlag {
  kind: "boolean";
  aliases?: string[];
}
interface ValueFlag {
  kind: "value";
  aliases?: string[];
  coerce: (raw: string) => unknown;
}
type Flag = BooleanFlag | ValueFlag;

function widen<T extends Flag>(flag: T): Flag { return flag; }
function replaceAliases(flag: Flag): void {
  if (flag.kind === "boolean") flag.aliases = ["changed"];
}
function retag(flag: Flag): void {
  if (flag.kind === "boolean") {
    const writable: { kind: string } = flag;
    writable.kind = "value";
  }
}
function tagOf(flag: Flag): string {
  return flag.kind === "value" ? "value" : "boolean";
}
function decode(flag: Flag): string {
  return flag.kind === "value" ? `${flag.coerce("abc")}` : "boolean";
}

const decoder: unknown = (raw: string): unknown => raw.length;
const original = { kind: "boolean", aliases: ["h"], coerce: decoder } as const satisfies BooleanFlag & { coerce: unknown };
const view = widen(original);
console.log(original.aliases.join(","), tagOf(view));
replaceAliases(view);
console.log(original.aliases.join(","), view.aliases?.join(","));
// The boolean view retains a method held under unknown in the original.
// Updating the discriminator must expose that method through the same object.
retag(view);
console.log(original.kind, tagOf(view), decode(view));
