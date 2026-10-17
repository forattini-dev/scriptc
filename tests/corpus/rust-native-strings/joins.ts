// @rust-only
// @no-engine
const SCOPES = ["core", "desktop", "wsl", "optional"] as const;
console.log(`limit to one scope (${SCOPES.join(", ")})`);
const strings: string[] = ["a", "", "c"];
const empty: string[] = [];
console.log("joins", strings.join(), strings.join(""), strings.join("::"), strings.join(undefined), strings.join(null as any), empty.join("/"));
const mixed: (string | number | boolean | null | undefined)[] = ["a", 2, true, null, undefined, -0];
console.log("mixed", mixed.join("|"), `${mixed}`);
const nested: number[][] = [[1, 2], [], [3]];
console.log("nested", nested.join(";"), `${nested}`);
const tuple = ["0", 1, false, "3", "4", "5", 6, "7", 8, 9, 10, 11] as const;
console.log("tuple", tuple.join("/"), `${tuple}`);
function separator(value?: string): string { return strings.join(value); }
console.log("optional", separator(), separator("+"));
function erasedSeparator(value: unknown): string { return strings.join(value as any); }
console.log("erased separator", erasedSeparator(undefined), erasedSeparator(null), erasedSeparator(false), erasedSeparator(-0));
