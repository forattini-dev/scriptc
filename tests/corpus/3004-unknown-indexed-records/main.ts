// Checked-dynamic slots already include undefined, including missing keys.
type Bag = Record<string, unknown>;
function child(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Bag)[key];
}
const bag: Bag = { text: "native", count: 3, nested: { color: "#abcdef" } };
console.log(String(bag["missing"]), String(bag["count"]));
console.log(String(child(bag, "text")), String(child(null, "text")));
const nested = child(bag, "nested");
console.log(String(child(nested, "color")), String(child(nested, "absent")));
function optional(value: Bag | undefined): unknown { return value?.["text"]; }
console.log(String(optional(bag)), String(optional(undefined)));
