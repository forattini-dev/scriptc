type Keys = { root: string; "10"?: string; "2"?: string; "01"?: string; "4294967295"?: string; z?: string; a?: string };
function build(yes: boolean): Keys {
  return { root: "r", ...(yes ? { "10": "ten", z: "z", "2": "two", "01": "one", "4294967295": "max" } : {}), a: "a", ...{ z: "again" } };
}
const value = build(true);
const keys = Object.keys(value);
console.log(keys.length, keys[0], keys[1], keys[2], keys[3], keys[4], keys[5], keys[6]);
const later = build(false);
const other = Object.keys(later);
console.log(other.length, other[0], other[1], other[2], later.z === "again");
const shadow = { hasOwn: (obj: Keys, name: string) => name === obj.root };
console.log(shadow.hasOwn(value, "r"));
function shadowed(): string {
  const Object = { keys: (obj: Keys) => [obj.root], hasOwn: (obj: Keys, key: string) => key === obj.root };
  console.log(Object.hasOwn(value, "r"));
  return Object.keys(value)[0];
}
console.log(shadowed());
