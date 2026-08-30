// @dynamic
// A function's dynamic own properties survive an any-typed overload return.

interface NamedCallback {
  (input: string): string;
  readonly displayName: string;
}

function component(name: string): NamedCallback;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function component(name: string): NamedCallback | any {
  const owned = (input: string): string => input.toUpperCase();
  Object.defineProperty(owned, "displayName", {
    value: name,
    enumerable: true,
  });
  return owned as NamedCallback;
}

const Owned = component("Owned");
console.log(Owned.displayName);
console.log(Owned("value"));
