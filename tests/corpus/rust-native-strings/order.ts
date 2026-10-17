// @rust-only
// @no-engine
function item(value: number): number { console.log("item", value); return value; }
console.log(`start ${item(1)} middle ${item(2)} end ${item(3)}`);
const values: string[] = ["first"];
function receiver(): string[] { console.log("receiver"); return values; }
function separator(): string { console.log("separator"); values.push("second"); return "|"; }
console.log(`ordered ${receiver().join(separator())} next ${item(4)}`);
function nullable(value: string | null | undefined): string { console.log("nullable"); return `${value}`; }
console.log("values", nullable(null), nullable(undefined));
