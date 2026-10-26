// @rust-only
// @no-engine
type Packet = { value?: number; label?: string; required: number };
const packet: Packet = { required: 1 };
const alias: Packet = packet;
console.log("absent", "value" in packet, "label" in alias, "required" in alias);
packet.value = undefined;
console.log("undefined", "value" in alias, packet.value === undefined, Object.hasOwn(packet, "value"));
packet.value = 0;
console.log("zero", "value" in alias, packet.value);
delete packet.value;
console.log("deleted", "value" in alias, "required" in alias);
const inherited = ["constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString"];
console.log("prototype", inherited.map(key => key in packet).join(","));
console.log("own", Object.hasOwn(packet, "toString"), "toString" in packet);
console.log("missing", "prototype" in packet, "toJSON" in packet, "" in packet);
const dictionary: Record<string, number | undefined> = { one: 1, nil: undefined };
const stored = dictionary;
console.log("dictionary", "one" in stored, "nil" in stored, "missing" in stored, "constructor" in stored);
dictionary.next = undefined;
console.log("added", "next" in stored);
delete dictionary.next;
console.log("removed", "next" in stored);
function narrowed(value: Packet | undefined): boolean { return value !== undefined && "required" in value; }
console.log("union", narrowed(packet), narrowed(undefined));
let current: Packet | undefined = packet;
function clear(): string { current = undefined; return "required"; }
if (current !== undefined) {
  try { console.log(clear() in current); }
  catch (error) { console.log("live-slot", error instanceof TypeError); }
}
export {};
const JSON = { rawJSON: false };
console.log("shadow-json", "rawJSON" in JSON, "stringify" in JSON, "toString" in JSON);
console.log("empty-object", "rawJSON" in {});
