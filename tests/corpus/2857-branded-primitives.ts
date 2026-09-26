// Primitive intersections whose object fields are literal type-only markers
// ride the primitive representation. This covers conventional generic string
// brands, unique-symbol-keyed numeric brands, writable legacy markers,
// boolean brands, and flows through records, arrays, unions, and functions.
type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
type UserId = Brand<string, "UserId">;
type Sequence = number & { __brand: "Sequence" };
declare const metersTag: unique symbol;
type Meters = number & { readonly [metersTag]: "Meters" };
type Enabled = boolean & { readonly __brand: true };

function userId(value: string): UserId {
  return value as UserId;
}

function brand<Value extends string, Name extends string>(value: Value, _name: Name): Brand<Value, Name> {
  return value as Brand<Value, Name>;
}

function meters(value: number): Meters {
  return value as Meters;
}

function double(value: Meters): Meters {
  return (value * 2) as Meters;
}

function describe(owner: UserId, distance: Meters): string {
  return owner.toUpperCase() + ":" + distance;
}

const route: { owner: UserId; distance: Meters } = {
  owner: userId("paolo"),
  distance: meters(21),
};
const owners: UserId[] = [route.owner, userId("lin"), brand("ada", "UserId")];
const sequence = 7 as Sequence;
const enabled = true as Enabled;
const maybeOwner: UserId | undefined = route.owner;

console.log(describe(route.owner, route.distance));
console.log(double(route.distance), sequence + 1);
console.log(owners.join(","), maybeOwner?.slice(1));
console.log(enabled ? "enabled" : "disabled");
