type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function read(values: ReadonlyMap<number, JsonObject>): string {
  return String(values.get(2)?.status);
}

const source = new Map<number, any>();
source.set(2, { status: "first" });
console.log(read(source));
source.set(2, { status: "second" });
console.log(read(source));
